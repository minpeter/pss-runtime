import type { AgentEvent, AgentRun } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { createWorkerCoordinator } from "./agent-factory";
import { drainCloudflareAlarm } from "./cloudflare-alarm-drainer";
import {
  createCloudflareDurableObjectHost,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
} from "./cloudflare-host";
import { routeWorkerRequest } from "./worker-route";

const prefix = "durable-test";

describe("Cloudflare durable alarm contract", () => {
  it("dedupes scheduled runs and session prompts while scheduling alarms", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ prefix, storage });
    const prompt = {
      idempotencyKey: "background-complete:session:bg_1",
      runId: "notification:bg_1",
    };

    await host.scheduler.enqueueRun("background:bg_1");
    await host.scheduler.enqueueRun("background:bg_1");
    await host.scheduler.resumeSession("session", prompt);
    await host.scheduler.resumeSession("session", prompt);

    await expect(
      listScheduledCloudflareRuns(storage, { prefix })
    ).resolves.toEqual(["background:bg_1"]);
    await expect(
      listScheduledCloudflareSessionPrompts(storage, { prefix })
    ).resolves.toEqual([{ ...prompt, sessionKey: "session" }]);
    expect(storage.alarmTime()).toBeDefined();
  });

  it("acks duplicate delivery once after a successful drain", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ prefix, storage });
    await host.scheduler.enqueueRun("background:bg_done");

    const summary = await drainCloudflareAlarm({
      agent: { resume: () => Promise.resolve(runWithText("done")) },
      prefix,
      storage,
    });
    const second = await drainCloudflareAlarm({
      agent: { resume: () => Promise.resolve(runWithText("should-not-run")) },
      prefix,
      storage,
    });

    expect(summary.resumedRuns).toEqual(["background:bg_done"]);
    expect(summary.events).toEqual([{ text: "done", type: "assistant-text" }]);
    expect(second.resumedRuns).toEqual([]);
    await expect(
      listScheduledCloudflareRuns(storage, { prefix })
    ).resolves.toEqual([]);
  });

  it("keeps retryable unclaimable work scheduled and reschedules the alarm", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ prefix, storage });
    await host.store.runs.create({
      checkpointVersion: 0,
      kind: "background-subagent",
      rootRunId: "background:bg_retry",
      runId: "background:bg_retry",
      sessionKey: "child:bg_retry",
      status: "queued",
    });
    await host.scheduler.enqueueRun("background:bg_retry");

    const summary = await drainCloudflareAlarm({
      agent: { resume: () => Promise.resolve(null) },
      prefix,
      storage,
    });

    expect(summary.failedRuns).toEqual([
      {
        error: "Run was not claimable during this alarm.",
        id: "background:bg_retry",
      },
    ]);
    await expect(
      listScheduledCloudflareRuns(storage, { prefix })
    ).resolves.toEqual(["background:bg_retry"]);
    expect(storage.alarmTime()).toBeDefined();
  });

  it("acks completed or missing non-retryable work", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ prefix, storage });
    await host.store.runs.create({
      checkpointVersion: 0,
      kind: "background-subagent",
      rootRunId: "background:bg_completed",
      runId: "background:bg_completed",
      sessionKey: "child:bg_completed",
      status: "completed",
    });
    await host.scheduler.enqueueRun("background:bg_completed");
    await host.scheduler.enqueueRun("background:bg_missing");
    await host.scheduler.resumeSession("session", {
      runId: "notification:bg_missing",
    });

    const summary = await drainCloudflareAlarm({
      agent: { resume: () => Promise.resolve(null) },
      prefix,
      storage,
    });

    expect(summary.failedRuns).toEqual([]);
    expect(summary.failedSessionPrompts).toEqual([]);
    await expect(
      listScheduledCloudflareRuns(storage, { prefix })
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareSessionPrompts(storage, { prefix })
    ).resolves.toEqual([]);
  });

  it("keeps route storage isolated across tenants and conversations", () => {
    const first = routeWorkerRequest("https://worker.example/turn", {
      conversationId: "ticket-a",
      tenantId: "tenant-a",
      userId: "user-a",
    });
    const second = routeWorkerRequest("https://worker.example/turn", {
      conversationId: "ticket-b",
      tenantId: "tenant-a",
      userId: "user-a",
    });
    const third = routeWorkerRequest("https://worker.example/turn", {
      conversationId: "ticket-a",
      tenantId: "tenant-b",
      userId: "user-a",
    });

    expect(
      new Set([first?.objectName, second?.objectName, third?.objectName]).size
    ).toBe(3);
    expect(
      new Set([first?.sessionKey, second?.sessionKey, third?.sessionKey]).size
    ).toBe(3);
    expect(
      new Set([first?.storePrefix, second?.storePrefix, third?.storePrefix])
        .size
    ).toBe(3);
  });

  it("parent session delete cancels queued child work without stale notification", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const host = createCloudflareDurableObjectHost({ prefix, storage });
    const agent = createWorkerCoordinator(
      storage,
      {},
      {
        prefix,
        scenario: "durable-background",
      }
    );
    const sessionKey = "tenant:a:conversation:b:user:c";
    const events = await collectEvents(
      await agent.session(sessionKey).send("start durable work")
    );
    const taskId = backgroundTaskIdFromEvents(events);
    const runId = (await listScheduledCloudflareRuns(storage, { prefix }))[0];
    if (!runId) {
      throw new Error("background run was not scheduled");
    }

    await agent.session(sessionKey).delete();
    await agent.resume(runId);

    await expect(host.store.runs.get(runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      host.store.notifications.getByIdempotencyKey(
        `background-complete:${sessionKey}:${taskId}`
      )
    ).resolves.toBeNull();
  });
});

function runWithText(text: string): AgentRun {
  return {
    // biome-ignore lint/suspicious/useAwait: AgentRun.events is an async iterable runtime contract.
    async *events(): AsyncIterable<AgentEvent> {
      yield { text, type: "assistant-text" };
    },
  };
}

async function collectEvents(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

function backgroundTaskIdFromEvents(events: readonly AgentEvent[]): string {
  for (const event of events) {
    if (
      event.type === "tool-result" &&
      typeof event.output === "object" &&
      event.output !== null &&
      "value" in event.output &&
      typeof event.output.value === "object" &&
      event.output.value !== null &&
      "task_id" in event.output.value &&
      typeof event.output.value.task_id === "string"
    ) {
      return event.output.value.task_id;
    }
  }
  throw new Error("background task id was not emitted");
}
