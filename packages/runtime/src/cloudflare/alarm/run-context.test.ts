import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun } from "../../index";
import {
  type CloudflareAlarmAgent,
  createCloudflareDurableObjectHost,
  drainCloudflareAlarm,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
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
      threadKey: "room:1:user:2",
      status: "queued",
    });
    await host.scheduler.enqueueRun("run-context");

    const summary = await drainCloudflareAlarm({
      agentForRun: (context) => {
        contexts.push(
          `${context.source}:${context.runId}:${context.threadKey}`
        );
        return agentWithEvents([
          { text: context.threadKey, type: "assistant-text" },
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

  it("passes thread prompt context and event callbacks to the alarm drain", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });
    const contexts: string[] = [];
    const observedEvents: string[] = [];

    await host.scheduler.resumeThread("room:1:user:2", {
      idempotencyKey: "reminder:1",
      notificationId: "notification-1",
      runId: "run-reminder",
    });

    await drainCloudflareAlarm({
      agentForRun: (context) => {
        contexts.push(
          `${context.source}:${context.idempotencyKey}:${context.notificationId}:${context.runId}:${context.threadKey}`
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
      "thread-prompt:reminder:1:notification-1:run-reminder:room:1:user:2",
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

  it("acknowledges orphaned thread prompts that cannot resolve a run", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.resumeThread("room:1:user:2", {
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

    expect(summary.failedThreadPrompts).toEqual([
      {
        error: "Thread prompt did not include or resolve to a run id.",
        id: "missing-notification",
      },
    ]);
    expect(summary.continuationScheduled).toBe(false);
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([]);
  });
});

function notificationRunRecord(runId: string, idempotencyKey = runId) {
  return {
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    rootRunId: runId,
    runId,
    threadKey: "room:1:user:2",
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
