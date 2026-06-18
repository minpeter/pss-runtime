import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentEvent, AgentRun } from "../index";
import { InMemorySqlStorage } from "./in-memory-sql-storage";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareSessionPrompt,
  type CloudflareAlarmAgent,
  type CloudflareDurableObjectId,
  type CloudflareDurableObjectNamespace,
  type CloudflareDurableObjectState,
  type CloudflareDurableObjectStorage,
  type CloudflareDurableObjectStub,
  createCloudflareDurableObjectHost,
  drainAgentRun,
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
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
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
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
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
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
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

  it("observes drained run events when an event callback is provided", async () => {
    const runEvents = [
      { text: "first", type: "assistant-text" },
      { text: "second", type: "assistant-text" },
    ] satisfies readonly AgentEvent[];
    const observedEvents: AgentEvent[] = [];

    const drainedEvents = await drainAgentRun(runWithEvents(runEvents), {
      onEvent: (event) => {
        observedEvents.push(event);
      },
    });

    expect(drainedEvents).toEqual(runEvents);
    expect(observedEvents).toEqual(runEvents);
  });

  it("types Durable Object platform shapes without Cloudflare worker globals", () => {
    type ExtraStub = CloudflareDurableObjectStub & {
      readonly kind: "extra";
    };

    expectTypeOf<
      CloudflareDurableObjectState["storage"]
    >().toEqualTypeOf<CloudflareDurableObjectStorage>();
    expectTypeOf<
      Parameters<CloudflareDurableObjectState["waitUntil"]>[0]
    >().toEqualTypeOf<Promise<unknown>>();
    expectTypeOf<
      ReturnType<CloudflareDurableObjectNamespace<ExtraStub>["idFromName"]>
    >().toEqualTypeOf<CloudflareDurableObjectId>();
    expectTypeOf<
      ReturnType<CloudflareDurableObjectNamespace<ExtraStub>["get"]>
    >().toEqualTypeOf<ExtraStub>();
  });
});

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
