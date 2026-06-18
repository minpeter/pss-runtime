import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun } from "../../index";
import {
  type CloudflareAlarmAgent,
  createCloudflareDurableObjectHost,
  drainCloudflareAlarm,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
} from "../index";
import { InMemorySqlStorage } from "../sql/node-test/node-sqlite-storage";

describe("Cloudflare alarm run contexts", () => {
  it("resolves agents per scheduled run context", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });
    const contexts: string[] = [];

    await host.store.runs.create({
      checkpointVersion: 0,
      kind: "notification",
      rootRunId: "run-context",
      runId: "run-context",
      sessionKey: "room:1:user:2",
      status: "queued",
    });
    await host.scheduler.enqueueRun("run-context");

    const summary = await drainCloudflareAlarm({
      agentForRun: (context) => {
        contexts.push(
          `${context.source}:${context.runId}:${context.sessionKey}`
        );
        return agentWithEvents([
          { text: context.sessionKey, type: "assistant-text" },
        ]);
      },
      prefix: "pss-runtime",
      storage,
    });

    expect(contexts).toEqual(["scheduled-run:run-context:room:1:user:2"]);
    expect(summary.events).toEqual([
      { text: "room:1:user:2", type: "assistant-text" },
    ]);
  });

  it("passes session prompt context and event callbacks to the alarm drain", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });
    const contexts: string[] = [];
    const observedEvents: string[] = [];

    await host.scheduler.resumeSession("room:1:user:2", {
      idempotencyKey: "reminder:1",
      notificationId: "notification-1",
      runId: "run-reminder",
    });

    await drainCloudflareAlarm({
      agentForRun: (context) => {
        contexts.push(
          `${context.source}:${context.idempotencyKey}:${context.notificationId}:${context.runId}:${context.sessionKey}`
        );
        return agentWithEvents([{ text: "done", type: "assistant-text" }]);
      },
      onEvent: (context, event) => {
        if (event.type === "assistant-text") {
          observedEvents.push(`${context.runId}:${event.text}`);
        }
      },
      prefix: "pss-runtime",
      storage,
    });

    expect(contexts).toEqual([
      "session-prompt:reminder:1:notification-1:run-reminder:room:1:user:2",
    ]);
    expect(observedEvents).toEqual(["run-reminder:done"]);
  });

  it("keeps scheduled work pending when failOnTurnError sees a turn error", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });

    await host.store.runs.create(notificationRunRecord("run-turn-error"));
    await host.scheduler.enqueueRun("run-turn-error");

    const summary = await drainCloudflareAlarm({
      agent: agentWithEvents([
        { type: "turn-error", message: "model unavailable" },
      ]),
      failOnTurnError: true,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.failedRuns).toEqual([
      { error: "model unavailable", id: "run-turn-error" },
    ]);
    expect(summary.continuationScheduled).toBe(true);
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      "run-turn-error",
    ]);
  });

  it("acknowledges stale scheduled runs that no longer exist", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.enqueueRun("missing-run");

    const summary = await drainCloudflareAlarm({
      agentForRun: () => {
        throw new Error("missing runs should not resolve an agent");
      },
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.failedRuns).toEqual([]);
    expect(summary.continuationScheduled).toBe(false);
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([]);
  });

  it("acknowledges orphaned session prompts that cannot resolve a run", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.resumeSession("room:1:user:2", {
      idempotencyKey: "missing-notification",
      runId: "",
    });

    const summary = await drainCloudflareAlarm({
      agentForRun: () => {
        throw new Error("orphaned prompts should not resolve an agent");
      },
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.failedSessionPrompts).toEqual([
      {
        error: "Session prompt did not include or resolve to a run id.",
        id: "missing-notification",
      },
    ]);
    expect(summary.continuationScheduled).toBe(false);
    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([]);
  });

  it("makes notification runs retryable after a session prompt turn error", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });
    const idempotencyKey = "notification:error";
    const runId = "notification-run-error";
    const sessionKey = "room:1:user:2";

    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "Reminder fired", type: "user-text" },
      notificationId: "notification-error",
      runId,
      sessionKey,
      status: "pending",
    });
    await host.store.runs.create(notificationRunRecord(runId, idempotencyKey));
    await host.scheduler.resumeSession(sessionKey, { idempotencyKey, runId });

    const summary = await drainCloudflareAlarm({
      agent: {
        resume: async () => {
          const run = await host.store.runs.get(runId);
          if (!run) {
            throw new Error("expected stored notification run");
          }
          await host.store.runs.update({
            ...run,
            lease: {
              attempt: 1,
              leaseId: "lease-before-turn-error",
              leaseUntilMs: Date.now() + 300_000,
            },
            status: "completed",
          });
          await host.store.notifications.claimByIdempotencyKey(idempotencyKey);
          return runWithEvents([
            { type: "turn-error", message: "model unavailable" },
          ]);
        },
      },
      failOnTurnError: true,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.failedSessionPrompts).toEqual([
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
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([{ idempotencyKey, runId, sessionKey }]);
  });

  it("makes notification runs retryable when a session prompt drain hits the event budget", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });
    const idempotencyKey = "notification:budget";
    const runId = "notification-run-budget";
    const sessionKey = "room:1:user:2";

    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "Reminder fired", type: "user-text" },
      notificationId: "notification-budget",
      runId,
      sessionKey,
      status: "pending",
    });
    await host.store.runs.create(notificationRunRecord(runId, idempotencyKey));
    await host.scheduler.resumeSession(sessionKey, { idempotencyKey, runId });

    const summary = await drainCloudflareAlarm({
      agent: {
        resume: async () => {
          const run = await host.store.runs.get(runId);
          if (!run) {
            throw new Error("expected stored notification run");
          }
          await host.store.runs.update({
            ...run,
            lease: {
              attempt: 1,
              leaseId: "lease-before-budget-stop",
              leaseUntilMs: Date.now() + 300_000,
            },
            status: "completed",
          });
          await host.store.notifications.claimByIdempotencyKey(idempotencyKey);
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
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([{ idempotencyKey, runId, sessionKey }]);
  });
});

function notificationRunRecord(runId: string, idempotencyKey = runId) {
  return {
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    rootRunId: runId,
    runId,
    sessionKey: "room:1:user:2",
    status: "queued",
  } as const;
}

function agentWithEvents(events: readonly AgentEvent[]): CloudflareAlarmAgent {
  return {
    resume: () => Promise.resolve(runWithEvents(events)),
  };
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
