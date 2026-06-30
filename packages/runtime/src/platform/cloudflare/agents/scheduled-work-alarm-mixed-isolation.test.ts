import { describe, expect, it } from "vitest";
import { drainCloudflareAlarm } from "../alarm/drainer";
import {
  createCloudflareDurableObjectHost,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../index";
import type { CloudflareAgentsFiberPayload } from "./index";
import {
  cloudflareAgentsThreadPayload,
  createCloudflareAgentsFiberRetryScheduler,
  createCloudflareAgentsFiberScheduler,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import {
  createFakeCloudflareAgent,
  type FakeCloudflareAgent,
  runWithText,
} from "./test-support";

describe("Cloudflare Agents scheduled work mixed alarm isolation", () => {
  it("drains only a legacy run when the same prefix also has a delayed Agents run", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const legacyHost = createCloudflareDurableObjectHost({
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

    await legacyHost.store.turns.create({
      checkpointVersion: 0,
      kind: "notification",
      rootRunId: "legacy-due-run",
      runId: "legacy-due-run",
      status: "queued",
      threadKey: "legacy-thread",
    });
    await legacyHost.scheduler.enqueueRun("legacy-due-run");
    await scheduler.enqueueRun("agents-delayed-run", { runAfterMs: 60_000 });

    expect(
      await listScheduledCloudflareRuns(storage, { prefix: "tenant-a" })
    ).toEqual(["legacy-due-run"]);
    expect(
      await listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).toEqual(["agents-delayed-run", "legacy-due-run"]);

    const summary = await drainCloudflareAlarm({
      agent: agentRecordingRuns(resumedRuns),
      prefix: "tenant-a",
      storage,
    });

    expect(resumedRuns).toEqual(["legacy-due-run"]);
    expect(summary.resumedRuns).toEqual(["legacy-due-run"]);
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
    expect(resumedRuns).toEqual(["legacy-due-run", "agents-delayed-run"]);
    expect(
      await listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).toEqual([]);
  });

  it("drains only a legacy thread prompt when the same prefix also has a delayed Agents thread retry", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const legacyHost = createCloudflareDurableObjectHost({
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

    await legacyHost.scheduler.resumeThread("legacy-thread", {
      runId: "legacy-thread-run",
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
    ).toEqual([{ runId: "legacy-thread-run", threadKey: "legacy-thread" }]);
    expect(
      await listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([
      agentsPrompt,
      { runId: "legacy-thread-run", threadKey: "legacy-thread" },
    ]);

    const summary = await drainCloudflareAlarm({
      agent: agentRecordingRuns(resumedRuns),
      prefix: "tenant-a",
      storage,
    });

    expect(resumedRuns).toEqual(["legacy-thread-run"]);
    expect(summary.consumedThreadPrompts).toEqual(["legacy-thread-run"]);
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
    expect(resumedRuns).toEqual(["legacy-thread-run", "agents-thread-run"]);
    expect(
      await listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([]);
  });
});

function agentRecordingRuns(resumedRuns: string[]) {
  return {
    resume: (runId: string) => {
      resumedRuns.push(runId);
      return Promise.resolve(runWithText(runId));
    },
  };
}

function resumeRecordingAgentsPayload(resumedRuns: string[]) {
  return (payload: CloudflareAgentsFiberPayload) => {
    resumedRuns.push(payload.runId);
    return Promise.resolve(runWithText(payload.runId));
  };
}

function resumeFirstScheduledAgent(
  cloudflareAgent: FakeCloudflareAgent,
  resumedRuns: string[]
) {
  return resumeScheduledCloudflareAgentsFiber({
    allowedPrefixes: ["tenant-a"],
    cloudflareAgent,
    payload: cloudflareAgent.scheduled.at(0)?.payload,
    resume: resumeRecordingAgentsPayload(resumedRuns),
    storage: cloudflareAgent.durableObjectContext.storage,
  });
}
