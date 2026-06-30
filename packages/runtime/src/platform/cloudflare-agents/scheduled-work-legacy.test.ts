import { describe, expect, it } from "vitest";
import {
  appendScheduledRunWork,
  appendScheduledThreadPromptWork,
} from "../cloudflare/host/scheduled-work-queue";
import type { CloudflareAgentsFiberPayload } from "./index";
import {
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
  resumeScheduledCloudflareAgentsFiber,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

describe("Cloudflare Agents scheduled work legacy rows", () => {
  it("resumes run rows written with old work id formats", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const startedRuns: string[] = [];

    await appendScheduledRunWork(
      storage,
      "tenant-a",
      "legacy-run",
      "legacy-run"
    );
    await appendScheduledRunWork(
      storage,
      "tenant-a",
      "legacy-retry|attempt:1",
      "legacy-retry"
    );

    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual(["legacy-run", "legacy-retry"]);
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgentsRunPayload({
          prefix: "tenant-a",
          runId: "legacy-run",
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
          runId: "legacy-retry",
        }),
        resume: (payload: CloudflareAgentsFiberPayload) => {
          startedRuns.push(payload.runId);
          return Promise.resolve(runWithText(payload.runId));
        },
        storage,
      })
    ).resolves.toMatchObject({ accepted: true, status: "completed" });

    expect(startedRuns).toEqual(["legacy-run", "legacy-retry"]);
    await expect(
      listScheduledCloudflareAgentsRuns(storage, { prefix: "tenant-a" })
    ).resolves.toEqual([]);
  });

  it("resumes thread prompt rows written with old work id formats", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const storage = cloudflareAgent.durableObjectContext.storage;
    const startedRuns: string[] = [];
    const legacyPrompt = {
      idempotencyKey: "legacy-key",
      notificationId: "legacy-notification",
      runId: "legacy-run",
      threadKey: "legacy-thread",
    };

    await appendScheduledThreadPromptWork(
      storage,
      "tenant-a",
      "13:legacy-thread|10:legacy-key|10:legacy-run",
      legacyPrompt
    );

    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).resolves.toEqual([legacyPrompt]);
    await expect(
      resumeScheduledCloudflareAgentsFiber({
        allowedPrefixes: ["tenant-a"],
        cloudflareAgent,
        payload: cloudflareAgentsThreadPayload({
          attempt: 1,
          idempotencyKey: "legacy-key",
          notificationId: "legacy-notification",
          prefix: "tenant-a",
          runId: "legacy-run",
          threadKey: "legacy-thread",
        }),
        resume: (payload: CloudflareAgentsFiberPayload) => {
          startedRuns.push(payload.runId);
          return Promise.resolve(runWithText(payload.runId));
        },
        storage,
      })
    ).resolves.toMatchObject({ accepted: true, status: "completed" });

    expect(startedRuns).toEqual(["legacy-run"]);
    await expect(
      listScheduledCloudflareAgentsThreadPrompts(storage, {
        prefix: "tenant-a",
      })
    ).resolves.toEqual([]);
  });
});
