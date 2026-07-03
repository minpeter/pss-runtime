import { describe, expect, it } from "vitest";
import { drainCloudflareAlarm } from "../alarm/drainer";
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

describe("Cloudflare Agents scheduled work alarm isolation", () => {
  it("keeps delayed run callbacks out of the alarm drain", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
      storage,
    });
    const resumedRuns: string[] = [];

    await scheduler.enqueueRun("background:bg_agents_delayed", {
      runAfterMs: 60_000,
    });
    const summary = await drainCloudflareAlarm({
      agent: agentRecordingRuns(resumedRuns),
      prefix: "tenant-a",
      storage,
    });

    expect(resumedRuns).toEqual([]);
    expect(summary.remainingRuns).toBe(0);
    expect(
      await listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).toEqual(["background:bg_agents_delayed"]);
    await expect(
      resumeFirstScheduledAgent(cloudflareAgent, resumedRuns)
    ).resolves.toMatchObject({ accepted: true, status: "completed" });
    expect(
      await listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).toEqual([]);
  });

  it("keeps delayed thread retries out of the alarm drain", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const retry = createCloudflareAgentsFiberRetryScheduler({
      cloudflareAgent,
      retryRunAfterMs: 60_000,
      storage,
    });
    const resumedRuns: string[] = [];

    await retry(
      cloudflareAgentsThreadPayload({
        idempotencyKey: "idem-agents-thread",
        notificationId: "notification-agents-thread",
        prefix: "tenant-a",
        runId: "run-agents-thread",
        threadKey: "thread-agents",
      }),
      "error"
    );
    const summary = await drainCloudflareAlarm({
      agent: agentRecordingRuns(resumedRuns),
      prefix: "tenant-a",
      storage,
    });

    expect(resumedRuns).toEqual([]);
    expect(summary.remainingThreadPrompts).toBe(0);
    expect(
      await listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).toEqual([
      {
        idempotencyKey: "idem-agents-thread",
        notificationId: "notification-agents-thread",
        runId: "run-agents-thread",
        threadKey: "thread-agents",
      },
    ]);
    await expect(
      resumeFirstScheduledAgent(cloudflareAgent, resumedRuns)
    ).resolves.toMatchObject({ accepted: true, status: "completed" });
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
