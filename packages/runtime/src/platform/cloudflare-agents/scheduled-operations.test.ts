import { describe, expect, it } from "vitest";
import type { CloudflareAgentsFiberPayload } from "./index";
import {
  ackScheduledCloudflareAgentsRun,
  createCloudflareAgentsFiberScheduler,
  listScheduledCloudflareAgentsRuns,
  rescheduleCloudflareAgentsSchedule,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents scheduled operations parity", () => {
  it("mirrors delayed Agents runs into the Durable Object queue", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
      storage,
    });

    await scheduler.enqueueRun("background:bg_delayed", { runAfterMs: 1200 });

    expect(cloudflareAgent.scheduled).toHaveLength(1);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["background:bg_delayed"]);

    await ackScheduledCloudflareAgentsRun(storage, "background:bg_delayed", {
      prefix: "tenant-a",
    });
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
    const ackedResult = await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[0]?.payload,
      resume: (payload: CloudflareAgentsFiberPayload) =>
        Promise.resolve(runWithText(payload.runId)),
      storage,
    });
    expect(ackedResult).toMatchObject({ accepted: false, status: "aborted" });
    expect(cloudflareAgent.started).toEqual([]);

    await scheduler.enqueueRun("background:bg_rescheduled", {
      runAfterMs: 1000,
    });
    await rescheduleCloudflareAgentsSchedule(storage, { runAfterMs: 5000 });
    expect(storageAlarmTime(storage)).toEqual(expect.any(Number));
    const consumedResult = await resumeScheduledCloudflareAgentsFiber({
      allowedPrefixes: ["tenant-a"],
      cloudflareAgent,
      payload: cloudflareAgent.scheduled[1]?.payload,
      resume: (payload: CloudflareAgentsFiberPayload) =>
        Promise.resolve(runWithText(payload.runId)),
      storage,
    });
    expect(consumedResult).toMatchObject({
      accepted: true,
      name: "pss-runtime:resume-run",
      status: "completed",
    });
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("claims mirrored delayed runs once across overlapping callbacks", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const scheduler = createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
      storage,
    });
    let resumed = 0;

    await scheduler.enqueueRun("background:bg_once", { runAfterMs: 1200 });
    const payload = cloudflareAgent.scheduled[0]?.payload;
    const results = await Promise.all([
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload,
        resume: (fiberPayload: CloudflareAgentsFiberPayload) => {
          resumed += 1;
          return Promise.resolve(runWithText(fiberPayload.runId));
        },
        storage,
      }),
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload,
        resume: (fiberPayload: CloudflareAgentsFiberPayload) => {
          resumed += 1;
          return Promise.resolve(runWithText(fiberPayload.runId));
        },
        storage,
      }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toHaveLength(1);
    expect(resumed).toBe(1);
    expect(cloudflareAgent.started).toHaveLength(1);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });
});

function storageAlarmTime(storage: unknown): number | undefined {
  if (typeof storage !== "object" || storage === null) {
    return;
  }
  if (!("alarmTime" in storage) || typeof storage.alarmTime !== "function") {
    return;
  }
  return storage.alarmTime();
}
