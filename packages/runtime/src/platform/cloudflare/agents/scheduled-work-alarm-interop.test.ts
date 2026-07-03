import { describe, expect, it } from "vitest";
import {
  appendScheduledRun,
  appendScheduledThreadPrompt,
} from "../host/scheduled-work-queue";
import {
  drainCloudflareAlarm,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../index";
import { insertScheduledWork } from "../storage/sqlite/scheduled-work-table";
import type { CloudflareAgentsFiberPayload } from "./index";
import {
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents alarm scheduler interop", () => {
  it("claims runs enqueued by the alarm scheduler, on any attempt", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const startedRuns: string[] = [];

    await appendScheduledRun(storage, "tenant-a", "alarm-run");
    await appendScheduledRun(storage, "tenant-a", "alarm-retried-run");

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["alarm-run", "alarm-retried-run"]);
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgentsRunPayload({
          prefix: "tenant-a",
          runId: "alarm-run",
        }),
        resume: (payload: CloudflareAgentsFiberPayload) => {
          startedRuns.push(payload.runId);
          return Promise.resolve(runWithText(payload.runId));
        },
        storage,
      })
    ).resolves.toMatchObject({ accepted: true, status: "completed" });
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgentsRunPayload({
          attempt: 1,
          prefix: "tenant-a",
          runId: "alarm-retried-run",
        }),
        resume: (payload: CloudflareAgentsFiberPayload) => {
          startedRuns.push(payload.runId);
          return Promise.resolve(runWithText(payload.runId));
        },
        storage,
      })
    ).resolves.toMatchObject({ accepted: true, status: "completed" });

    expect(startedRuns).toEqual(["alarm-run", "alarm-retried-run"]);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("claims thread prompts enqueued by the alarm scheduler", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const startedRuns: string[] = [];
    const prompt = {
      idempotencyKey: "alarm-key",
      notificationId: "alarm-notification",
      runId: "alarm-run",
      threadKey: "alarm-thread",
    };

    await appendScheduledThreadPrompt(storage, "tenant-a", prompt);

    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).resolves.toEqual([prompt]);
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgentsThreadPayload({
          attempt: 1,
          idempotencyKey: "alarm-key",
          notificationId: "alarm-notification",
          prefix: "tenant-a",
          runId: "alarm-run",
          threadKey: "alarm-thread",
        }),
        resume: (payload: CloudflareAgentsFiberPayload) => {
          startedRuns.push(payload.runId);
          return Promise.resolve(runWithText(payload.runId));
        },
        storage,
      })
    ).resolves.toMatchObject({ accepted: true, status: "completed" });

    expect(startedRuns).toEqual(["alarm-run"]);
    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareThreadPrompts(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("hides shared-kind rows that do not match the alarm work id format", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const resumedRuns: string[] = [];

    await insertScheduledWork(
      storage,
      "tenant-a",
      "run",
      "8:foreign-run|1:1",
      "foreign-run",
      { runId: "foreign-run" }
    );
    await insertScheduledWork(
      storage,
      "tenant-a",
      "thread-prompt",
      "not-a-canonical-id",
      {
        runId: "foreign-thread-run",
        threadKey: "foreign-thread",
      },
      { runId: "foreign-thread-run", threadKey: "foreign-thread" }
    );

    await expect(
      listScheduledCloudflareRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareThreadPrompts(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).resolves.toEqual([]);

    const summary = await drainCloudflareAlarm({
      agent: {
        resume: (runId) => {
          resumedRuns.push(runId);
          return Promise.resolve(runWithText(runId));
        },
      },
      prefix: "tenant-a",
      storage,
    });

    expect(resumedRuns).toEqual([]);
    expect(summary.remainingRuns).toBe(0);
    expect(summary.remainingThreadPrompts).toBe(0);
  });
});
