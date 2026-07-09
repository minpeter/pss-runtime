import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentTurn } from "../../../index";
import {
  type CloudflareAlarmAgent,
  CloudflareAlarmDrainFailureError,
  createCloudflareStorageHost,
  drainCloudflareAlarm,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../index";
import { InMemorySqlStorage } from "../sql/node-test/node-sqlite-storage";

describe("Cloudflare alarm drain budgets", () => {
  it("re-arms continuation when the run budget leaves backlog", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

    await enqueueStoredRun(host, "run-a");
    await enqueueStoredRun(host, "run-b");
    await enqueueStoredRun(host, "run-c");

    const summary = await drainCloudflareAlarm({
      agent: agentWithEvents([{ text: "a", type: "assistant-output" }]),
      maxRuns: 1,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.resumedRuns).toEqual(["run-a"]);
    expect(summary.remainingRuns).toBe(2);
    expect(summary.continuationScheduled).toBe(true);
    expect(summary.continuationReasons).toContain("run-budget");
    expect(storage.alarmTime()).not.toBeUndefined();
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      "run-b",
      "run-c",
    ]);
  });

  it("re-arms continuation when the deadline leaves run backlog", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

    await host.scheduler.enqueueRun("run-a");
    await host.scheduler.enqueueRun("run-b");

    const summary = await drainCloudflareAlarm({
      agent: agentWithEvents([{ text: "unused", type: "assistant-output" }]),
      deadlineMs: 0,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.resumedRuns).toEqual([]);
    expect(summary.remainingRuns).toBe(2);
    expect(summary.continuationScheduled).toBe(true);
    expect(summary.continuationReasons).toContain("deadline");
    expect(storage.alarmTime()).not.toBeUndefined();
  });

  it("re-arms continuation when the thread prompt budget leaves backlog", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

    await host.scheduler.resumeThread("thread-a", { runId: "run-a" });
    await host.scheduler.resumeThread("thread-b", { runId: "run-b" });

    const summary = await drainCloudflareAlarm({
      agent: agentWithEvents([{ text: "done", type: "assistant-output" }]),
      maxThreadPrompts: 1,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.consumedThreadPrompts).toEqual(["run-a"]);
    expect(summary.remainingThreadPrompts).toBe(1);
    expect(summary.continuationScheduled).toBe(true);
    expect(summary.continuationReasons).toContain("thread-prompt-budget");
    await expect(
      listScheduledCloudflareThreadPrompts(storage)
    ).resolves.toEqual([{ runId: "run-b", threadKey: "thread-b" }]);
  });

  it("caps retained events without buffering the full run stream", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });
    let yieldedEvents = 0;

    await enqueueStoredRun(host, "run-events");

    const summary = await drainCloudflareAlarm({
      agent: agentWithStream(async function* () {
        const events = [
          { text: "one", type: "assistant-output" },
          { text: "two", type: "assistant-output" },
          { text: "three", type: "assistant-output" },
        ] satisfies readonly AgentEvent[];
        for (const event of events) {
          await Promise.resolve();
          yieldedEvents += 1;
          yield event;
        }
      }),
      maxEvents: 1,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.events).toEqual([{ text: "one", type: "assistant-output" }]);
    expect(summary.droppedEvents).toBe(1);
    expect(summary.continuationScheduled).toBe(true);
    expect(summary.continuationReasons).toContain("event-budget");
    expect(summary.continuationReasons).not.toContain("deadline");
    expect(yieldedEvents).toBe(2);
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      "run-events",
    ]);
  });

  it("stops a resumed run when the deadline expires inside the event stream", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

    await enqueueStoredRun(host, "run-deadline");

    const summary = await drainCloudflareAlarm({
      agent: agentWithStream(async function* () {
        yield { text: "before deadline", type: "assistant-output" };
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { text: "after deadline", type: "assistant-output" };
      }),
      deadlineMs: 10,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.events).toEqual([
      { text: "before deadline", type: "assistant-output" },
    ]);
    expect(summary.droppedEvents).toBe(0);
    expect(summary.continuationScheduled).toBe(true);
    expect(summary.continuationReasons).toContain("deadline");
    expect(summary.continuationReasons).not.toContain("event-budget");
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      "run-deadline",
    ]);
  });

  it("throws an opt-in failure error after re-arming failed work", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

    await enqueueStoredRun(host, "run-unclaimable");

    await expect(
      drainCloudflareAlarm({
        agent: { resume: () => Promise.resolve(null) },
        prefix: "pss-runtime",
        storage,
        throwOnFailure: true,
      })
    ).rejects.toBeInstanceOf(CloudflareAlarmDrainFailureError);
    expect(storage.alarmTime()).not.toBeUndefined();
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([
      "run-unclaimable",
    ]);
  });

  it("acks scheduled non-notification runs when resume returns null", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareStorageHost({ storage });

    await enqueueStoredRun(host, "run-user-turn", "user-turn");

    const summary = await drainCloudflareAlarm({
      agent: { resume: () => Promise.resolve(null) },
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.failedRuns).toEqual([]);
    expect(summary.remainingRuns).toBe(0);
    expect(summary.continuationScheduled).toBe(false);
    await expect(listScheduledCloudflareRuns(storage)).resolves.toEqual([]);
  });
});

function agentWithEvents(events: readonly AgentEvent[]): CloudflareAlarmAgent {
  return {
    resume: () => Promise.resolve(runWithEvents(events)),
  };
}

async function enqueueStoredRun(
  host: ReturnType<typeof createCloudflareStorageHost>,
  runId: string,
  kind: "notification" | "user-turn" = "notification"
): Promise<void> {
  await host.store.turns.create({
    checkpointVersion: 0,
    kind,
    rootRunId: runId,
    runId,
    threadKey: "thread:test",
    status: "queued",
  });
  await host.scheduler.enqueueRun(runId);
}

function agentWithStream(
  stream: () => AsyncIterable<AgentEvent>
): CloudflareAlarmAgent {
  return {
    resume: () => Promise.resolve({ events: stream }),
  };
}

function runWithEvents(events: readonly AgentEvent[]): AgentTurn {
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
