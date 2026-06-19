import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun } from "../../../index";
import {
  createCloudflareDurableObjectHost,
  drainCloudflareAlarm,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareThreadPrompts,
} from "../index";
import { InMemorySqlStorage } from "../sql/node-test/node-sqlite-storage";

describe("Cloudflare alarm thread prompt retries", () => {
  it("makes notification runs retryable after a thread prompt turn error", async () => {
    const { host, idempotencyKey, runId, threadKey, storage } =
      await createScheduledNotification("notification:error");

    const summary = await drainCloudflareAlarm({
      agent: {
        resume: async () => {
          await completeAndClaimNotification({ host, idempotencyKey, runId });
          return runWithEvents([
            { type: "turn-error", message: "model unavailable" },
          ]);
        },
      },
      failOnTurnError: true,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.failedThreadPrompts).toEqual([
      { error: "model unavailable", id: idempotencyKey },
    ]);
    expect(summary.continuationScheduled).toBe(true);
    await expect(host.store.runs.get(runId)).resolves.toEqual(
      expect.objectContaining({ status: "queued" })
    );
    expect((await host.store.runs.get(runId))?.lease).toBeUndefined();
    await expect(
      host.store.notifications.getByIdempotencyKey(idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "pending" }));
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([{ idempotencyKey, runId, threadKey }]);
  });

  it("makes notification runs retryable when a thread prompt drain hits the event budget", async () => {
    const { host, idempotencyKey, runId, threadKey, storage } =
      await createScheduledNotification("notification:budget");

    const summary = await drainCloudflareAlarm({
      agent: {
        resume: async () => {
          await completeAndClaimNotification({ host, idempotencyKey, runId });
          return runWithEvents([
            { text: "first", type: "assistant-text" },
            { text: "second", type: "assistant-text" },
          ]);
        },
      },
      maxEvents: 1,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.events).toEqual([{ text: "first", type: "assistant-text" }]);
    expect(summary.continuationReasons).toContain("event-budget");
    expect(summary.continuationScheduled).toBe(true);
    await expect(host.store.runs.get(runId)).resolves.toEqual(
      expect.objectContaining({ status: "queued" })
    );
    expect((await host.store.runs.get(runId))?.lease).toBeUndefined();
    await expect(
      host.store.notifications.getByIdempotencyKey(idempotencyKey)
    ).resolves.toEqual(expect.objectContaining({ status: "pending" }));
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([{ idempotencyKey, runId, threadKey }]);
  });
});

async function completeAndClaimNotification({
  host,
  idempotencyKey,
  runId,
}: {
  readonly host: ReturnType<typeof createCloudflareDurableObjectHost>;
  readonly idempotencyKey: string;
  readonly runId: string;
}): Promise<void> {
  const run = await host.store.runs.get(runId);
  if (!run) {
    throw new Error("expected stored notification run");
  }
  await host.store.runs.update({
    ...run,
    lease: {
      attempt: 1,
      leaseId: "lease-before-retry-stop",
      leaseUntilMs: Date.now() + 300_000,
    },
    status: "completed",
  });
  await host.store.notifications.claimByIdempotencyKey(idempotencyKey);
}

async function createScheduledNotification(idempotencyKey: string): Promise<{
  readonly host: ReturnType<typeof createCloudflareDurableObjectHost>;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly threadKey: string;
  readonly storage: InMemoryCloudflareDurableObjectStorage;
}> {
  const storage = new InMemoryCloudflareDurableObjectStorage({
    sql: new InMemorySqlStorage(),
  });
  const host = createCloudflareDurableObjectHost({ storage });
  const runId = `${idempotencyKey}:run`;
  const threadKey = "room:1:user:2";

  await host.store.notifications.enqueue({
    idempotencyKey,
    input: { text: "Reminder fired", type: "user-text" },
    notificationId: `${idempotencyKey}:notification`,
    runId,
    threadKey,
    status: "pending",
  });
  await host.store.runs.create({
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    rootRunId: runId,
    runId,
    threadKey,
    status: "queued",
  });
  await host.scheduler.resumeThread(threadKey, { idempotencyKey, runId });

  return { host, idempotencyKey, runId, threadKey, storage };
}

function runWithEvents(events: readonly AgentEvent[]): AgentRun {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
