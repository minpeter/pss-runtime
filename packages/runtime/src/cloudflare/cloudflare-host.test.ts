import { describe, expect, it } from "vitest";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareSessionPrompt,
  type CloudflareAlarmAgent,
  createCloudflareDurableObjectHost,
  drainCloudflareAlarm,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
} from "./index";

const unclaimableAgent = {
  resume: () => Promise.resolve(null),
} satisfies CloudflareAlarmAgent;

describe("Cloudflare Durable Object host adapter", () => {
  it("stores scheduled runs and session prompts until they are acked", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ storage });
    const runId = "background:bg_cloudflare_delayed";
    const idempotencyKey = "background-complete:example:bg_delayed";
    const notificationRunId = "notification-run-delayed";
    const prompt = {
      idempotencyKey,
      runId: notificationRunId,
      sessionKey: "example",
    };

    await host.scheduler.enqueueRun(runId);
    await host.scheduler.enqueueRun(runId);
    await host.scheduler.resumeSession("example", {
      idempotencyKey,
      runId: notificationRunId,
    });
    await host.scheduler.resumeSession("example", {
      idempotencyKey,
      runId: notificationRunId,
    });
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "ready", type: "user-text" },
      notificationId: "notification-delayed",
      runId: notificationRunId,
      sessionKey: "example",
      status: "pending",
    });

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      runId,
    ]);
    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([prompt]);
    await ackScheduledCloudflareRun(storage, runId);
    await ackScheduledCloudflareSessionPrompt(storage, prompt);

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([]);
    await expect(
      host.store.notifications.claimByIdempotencyKey(idempotencyKey)
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps unclaimable scheduled runs pending and reschedules the alarm", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ storage });
    const runId = "background:bg_retry";

    await host.scheduler.enqueueRun(runId);

    const summary = await drainCloudflareAlarm({
      agent: unclaimableAgent,
      prefix: "pss-runtime",
      storage,
    });

    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      runId,
    ]);
    expect(summary.failedRuns).toEqual([
      { error: "Run was not claimable during this alarm.", id: runId },
    ]);
    expect(storage.alarmTime()).not.toBeUndefined();
  });

  it("keeps unclaimable scheduled session prompts pending and reschedules the alarm", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ storage });
    const idempotencyKey = "background-complete:demo:bg_unclaimable";
    const runId = "notification:bg_unclaimable";
    const prompt = {
      idempotencyKey,
      runId,
      sessionKey: "room:demo:user:edge",
    };

    await host.scheduler.resumeSession(prompt.sessionKey, {
      idempotencyKey,
      runId,
    });

    const summary = await drainCloudflareAlarm({
      agent: unclaimableAgent,
      prefix: "pss-runtime",
      storage,
    });

    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([prompt]);
    expect(summary.failedSessionPrompts).toEqual([
      {
        error: "Session prompt was not claimable during this alarm.",
        id: idempotencyKey,
      },
    ]);
    expect(storage.alarmTime()).not.toBeUndefined();
  });
});
