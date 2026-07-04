import { describe, expect, it } from "vitest";
import { drainCloudflareAlarm } from "../alarm/drainer";
import {
  createCloudflareDurableObjectHost,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../index";
import {
  cloudflareAgentsThreadPayload,
  createCloudflareAgentsFiberRetryScheduler,
  createCloudflareAgentsFiberScheduler,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
} from "./index";
import {
  agentRecordingRuns,
  resumeFirstScheduledAgent,
} from "./scheduled-work-alarm-test-support";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents scheduled work mixed alarm isolation", () => {
  it("drains only an alarm-scheduled run when the same prefix also has a delayed Agents run", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const alarmHost = createCloudflareDurableObjectHost({
      prefix: "tenant-a",
      storage,
    });
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
      storage,
    });
    const resumedRuns: string[] = [];

    await alarmHost.store.turns.create({
      checkpointVersion: 0,
      kind: "notification",
      rootRunId: "alarm-due-run",
      runId: "alarm-due-run",
      status: "queued",
      threadKey: "alarm-thread",
    });
    await alarmHost.scheduler.enqueueRun("alarm-due-run");
    await scheduler.enqueueRun("agents-delayed-run", { runAfterMs: 60_000 });

    expect(
      await listScheduledCloudflareRuns(storage, { prefix: "tenant-a" })
    ).toEqual(["alarm-due-run"]);
    expect(
      await listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).toEqual(["agents-delayed-run", "alarm-due-run"]);

    const summary = await drainCloudflareAlarm({
      agent: agentRecordingRuns(resumedRuns),
      prefix: "tenant-a",
      storage,
    });

    expect(resumedRuns).toEqual(["alarm-due-run"]);
    expect(summary.resumedRuns).toEqual(["alarm-due-run"]);
    expect(summary.remainingRuns).toBe(0);
    expect(
      await listScheduledCloudflareRuns(storage, { prefix: "tenant-a" })
    ).toEqual([]);
    expect(
      await listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).toEqual(["agents-delayed-run"]);

    await expect(
      resumeFirstScheduledAgent(cloudflareAgent, resumedRuns)
    ).resolves.toMatchObject({ accepted: true, status: "completed" });
    expect(resumedRuns).toEqual(["alarm-due-run", "agents-delayed-run"]);
    expect(
      await listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).toEqual([]);
  });

  it("drains only an alarm-scheduled thread prompt when the same prefix also has a delayed Agents thread retry", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const alarmHost = createCloudflareDurableObjectHost({
      prefix: "tenant-a",
      storage,
    });
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryRunAfterMs: 60_000,
      storage,
    });
    const agentsPrompt = {
      idempotencyKey: "agents-thread-key",
      notificationId: "agents-notification",
      runId: "agents-thread-run",
      threadKey: "agents-thread",
    };
    const resumedRuns: string[] = [];

    await alarmHost.scheduler.resumeThread("alarm-thread", {
      runId: "alarm-thread-run",
    });
    await retry(
      cloudflareAgentsThreadPayload({
        idempotencyKey: agentsPrompt.idempotencyKey,
        notificationId: agentsPrompt.notificationId,
        prefix: "tenant-a",
        runId: agentsPrompt.runId,
        threadKey: agentsPrompt.threadKey,
      }),
      "error"
    );

    expect(
      await listScheduledCloudflareThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([{ runId: "alarm-thread-run", threadKey: "alarm-thread" }]);
    expect(
      await listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([
      agentsPrompt,
      { runId: "alarm-thread-run", threadKey: "alarm-thread" },
    ]);

    const summary = await drainCloudflareAlarm({
      agent: agentRecordingRuns(resumedRuns),
      prefix: "tenant-a",
      storage,
    });

    expect(resumedRuns).toEqual(["alarm-thread-run"]);
    expect(summary.consumedThreadPrompts).toEqual(["alarm-thread-run"]);
    expect(summary.remainingThreadPrompts).toBe(0);
    expect(
      await listScheduledCloudflareThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([]);
    expect(
      await listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([agentsPrompt]);

    await expect(
      resumeFirstScheduledAgent(cloudflareAgent, resumedRuns)
    ).resolves.toMatchObject({ accepted: true, status: "completed" });
    expect(resumedRuns).toEqual(["alarm-thread-run", "agents-thread-run"]);
    expect(
      await listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([]);
  });
});
