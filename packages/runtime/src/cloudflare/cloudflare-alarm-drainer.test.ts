import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRun } from "../index";
import { InMemorySqlStorage } from "./in-memory-sql-storage";
import {
  type CloudflareAlarmAgent,
  CloudflareAlarmDrainFailureError,
  createCloudflareDurableObjectHost,
  drainCloudflareAlarm,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
} from "./index";

describe("Cloudflare alarm drain budgets", () => {
  it("re-arms continuation when the run budget leaves backlog", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.enqueueRun("run-a");
    await host.scheduler.enqueueRun("run-b");
    await host.scheduler.enqueueRun("run-c");

    const summary = await drainCloudflareAlarm({
      agent: agentWithEvents([{ text: "a", type: "assistant-text" }]),
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
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.enqueueRun("run-a");
    await host.scheduler.enqueueRun("run-b");

    const summary = await drainCloudflareAlarm({
      agent: agentWithEvents([{ text: "unused", type: "assistant-text" }]),
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

  it("re-arms continuation when the session prompt budget leaves backlog", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.resumeSession("session-a", { runId: "run-a" });
    await host.scheduler.resumeSession("session-b", { runId: "run-b" });

    const summary = await drainCloudflareAlarm({
      agent: agentWithEvents([{ text: "done", type: "assistant-text" }]),
      maxSessionPrompts: 1,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.consumedSessionPrompts).toEqual(["run-a"]);
    expect(summary.remainingSessionPrompts).toBe(1);
    expect(summary.continuationScheduled).toBe(true);
    expect(summary.continuationReasons).toContain("session-prompt-budget");
    await expect(
      listScheduledCloudflareSessionPrompts(storage)
    ).resolves.toEqual([{ runId: "run-b", sessionKey: "session-b" }]);
  });

  it("caps retained events without buffering the full run stream", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });
    let yieldedEvents = 0;

    await host.scheduler.enqueueRun("run-events");

    const summary = await drainCloudflareAlarm({
      agent: agentWithStream(async function* () {
        const events = [
          { text: "one", type: "assistant-text" },
          { text: "two", type: "assistant-text" },
          { text: "three", type: "assistant-text" },
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

    expect(summary.events).toEqual([{ text: "one", type: "assistant-text" }]);
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
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.enqueueRun("run-deadline");

    const summary = await drainCloudflareAlarm({
      agent: agentWithStream(async function* () {
        yield { text: "before deadline", type: "assistant-text" };
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { text: "after deadline", type: "assistant-text" };
      }),
      deadlineMs: 10,
      prefix: "pss-runtime",
      storage,
    });

    expect(summary.events).toEqual([
      { text: "before deadline", type: "assistant-text" },
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
    const host = createCloudflareDurableObjectHost({ storage });

    await host.scheduler.enqueueRun("run-unclaimable");

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
});

function agentWithEvents(events: readonly AgentEvent[]): CloudflareAlarmAgent {
  return {
    resume: () => Promise.resolve(runWithEvents(events)),
  };
}

function agentWithStream(
  stream: () => AsyncIterable<AgentEvent>
): CloudflareAlarmAgent {
  return {
    resume: () => Promise.resolve({ events: stream }),
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
