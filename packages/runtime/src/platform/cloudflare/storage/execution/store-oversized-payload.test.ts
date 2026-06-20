import { describe, expect, it } from "vitest";
import type { TurnRecord } from "../../../../execution";
import type { AgentEvent } from "../../../../index";
import { createCloudflareDurableObjectHost } from "../../index";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import {
  type StorageLatencyTiming,
  summarizeStorageLatencyTimings,
} from "./storage-metrics";
import { countRows } from "./store-stress-assertions";

const payloadBudget = 64_000;
const oversizedEventText = makeText("model-event", 384_000);
const oversizedCheckpointText = makeText("checkpoint", 384_000);
const oversizedThreadText = makeText("thread-message", 144_000);
const oversizedUserInput = makeText("user-input", 384_000);
const prefix = "oversized-payload-stress";
const runId = "agent-1:user-1:thread-1:run-1";
const threadKey = "agent-1:user-1:thread-1";

describe("DurableObjectExecutionStore oversized payload stress", () => {
  it("round-trips large user input, assistant responses, tool output, and checkpoint state", async () => {
    const sql = new InMemorySqlStorage();
    const storage = new InMemoryCloudflareDurableObjectStorage({ sql });
    const host = createCloudflareDurableObjectHost({
      maxPayloadBytes: payloadBudget,
      prefix,
      storage,
    });

    const threadCommit = await host.store.threads.commit(
      threadKey,
      {
        state: {
          history: [
            { content: oversizedThreadText, role: "user" },
            { content: oversizedThreadText, role: "assistant" },
          ],
          schemaVersion: 1,
        },
      },
      { expectedVersion: null }
    );
    expect(threadCommit).toEqual({ ok: true, version: "1" });

    const run = runRecord({ runId, threadKey });
    await host.store.turns.create(run);
    await host.store.events.append(runId, {
      text: oversizedEventText,
      type: "assistant-text",
    });
    await host.store.events.append(runId, {
      output: { text: oversizedEventText },
      toolCallId: "call_oversized",
      toolName: "mock_model_output",
      type: "tool-result",
    });
    await host.store.checkpoints.append(
      {
        checkpointId: `${runId}:checkpoint-1`,
        phase: "after-model",
        runId,
        runtimeState: { modelOutput: oversizedCheckpointText },
        threadSnapshot: { threadKey, version: "1" },
        version: 1,
      },
      { expectedVersion: 0 }
    );
    await host.store.turns.update({
      ...run,
      checkpointVersion: 1,
      status: "completed",
    });
    await host.store.notifications.enqueue({
      idempotencyKey: `${runId}:notification`,
      input: { text: oversizedUserInput, type: "user-text" },
      notificationId: `${runId}:notification`,
      runId,
      status: "pending",
      threadKey,
    });

    const loadedThread = await host.store.threads.load(threadKey);
    expect(threadHistoryTextLength(loadedThread?.state, 0)).toBe(
      oversizedThreadText.length
    );
    expect(threadHistoryTextLength(loadedThread?.state, 1)).toBe(
      oversizedThreadText.length
    );
    expect(await collectEventSummaries(host.store.events, runId)).toEqual([
      { textLength: oversizedEventText.length, type: "assistant-text" },
      { outputLength: oversizedEventText.length, type: "tool-result" },
    ]);
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      runtimeState: { modelOutput: oversizedCheckpointText },
      version: 1,
    });
    const claimedNotification =
      await host.store.notifications.claimByIdempotencyKey(
        `${runId}:notification`
      );
    expect(claimedNotification).toMatchObject({
      ok: true,
      record: { input: { text: oversizedUserInput, type: "user-text" } },
    });
    expect(countRows(sql, "pss_thread_message_chunk")).toBeGreaterThan(0);
    expect(countRows(sql, "pss_payload_chunk")).toBeGreaterThan(0);
  }, 20_000);

  it("keeps storage overhead below 100ms for extreme local payload operations", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({
      maxPayloadBytes: payloadBudget,
      prefix: "oversized-payload-latency",
      storage,
    });
    const latencyThreadKey = "agent-latency:user-1:thread-1";
    const latencyRunId = "agent-latency:user-1:thread-1:run-1";
    const hugeUserInput = makeText("huge-user-input", 384_000);
    const hugeAssistantOutput = makeText("huge-assistant-output", 384_000);
    const timings: StorageLatencyTiming[] = [];

    const threadCommit = await timed(timings, "thread commit", () =>
      host.store.threads.commit(
        latencyThreadKey,
        {
          state: {
            history: [
              { content: hugeUserInput, role: "user" },
              { content: hugeAssistantOutput, role: "assistant" },
            ],
            schemaVersion: 1,
          },
        },
        { expectedVersion: null }
      )
    );
    expect(threadCommit).toEqual({ ok: true, version: "1" });

    const run = runRecord({
      runId: latencyRunId,
      threadKey: latencyThreadKey,
    });
    await timed(timings, "run create", () => host.store.turns.create(run));
    await timed(timings, "assistant event append", () =>
      host.store.events.append(latencyRunId, {
        text: hugeAssistantOutput,
        type: "assistant-text",
      })
    );
    await timed(timings, "tool event append", () =>
      host.store.events.append(latencyRunId, {
        output: { text: hugeAssistantOutput },
        toolCallId: "call_latency",
        toolName: "large_tool",
        type: "tool-result",
      })
    );
    await timed(timings, "checkpoint append", () =>
      host.store.checkpoints.append(
        {
          checkpointId: `${latencyRunId}:checkpoint-1`,
          phase: "after-tool",
          runId: latencyRunId,
          runtimeState: { modelOutput: hugeAssistantOutput, next: "model" },
          threadSnapshot: { threadKey: latencyThreadKey, version: "1" },
          version: 1,
        },
        { expectedVersion: 0 }
      )
    );
    await timed(timings, "run update", () =>
      host.store.turns.update({
        ...run,
        checkpointVersion: 1,
        status: "completed",
      })
    );
    await timed(timings, "notification enqueue", () =>
      host.store.notifications.enqueue({
        idempotencyKey: `${latencyRunId}:notification`,
        input: { text: hugeUserInput, type: "user-text" },
        notificationId: `${latencyRunId}:notification`,
        runId: latencyRunId,
        status: "pending",
        threadKey: latencyThreadKey,
      })
    );
    await timed(timings, "scheduler enqueue run", () =>
      host.scheduler.enqueueRun(latencyRunId)
    );
    await timed(timings, "scheduler resume thread", () =>
      host.scheduler.resumeThread(latencyThreadKey, {
        idempotencyKey: `${latencyRunId}:notification`,
        runId: latencyRunId,
      })
    );
    await timed(timings, "thread load", () =>
      host.store.threads.load(latencyThreadKey)
    );
    await timed(timings, "event read", () =>
      collectEventSummaries(host.store.events, latencyRunId)
    );
    await timed(timings, "checkpoint latest", () =>
      host.store.checkpoints.latest(latencyRunId)
    );
    await timed(timings, "notification claim", () =>
      host.store.notifications.claimByIdempotencyKey(
        `${latencyRunId}:notification`
      )
    );

    const summary = summarizeStorageLatencyTimings(timings);
    expect(summary.count).toBe(timings.length);
    expect(summary.maxMs).toBeLessThan(100);
    expect(summary.p95Ms).toBeLessThan(100);
  }, 20_000);
});

function runRecord(input: {
  readonly runId: string;
  readonly threadKey: string;
}): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: input.runId,
    runId: input.runId,
    status: "queued",
    threadKey: input.threadKey,
  };
}

async function collectEventSummaries(
  events: {
    read(runId: string): AsyncIterable<{ readonly event: AgentEvent }>;
  },
  runIdValue: string
): Promise<readonly EventSummary[]> {
  const collected: EventSummary[] = [];
  for await (const entry of events.read(runIdValue)) {
    collected.push(eventSummary(entry.event));
  }
  return collected;
}

function makeText(label: string, size: number): string {
  return `${label}:`.padEnd(size, "x");
}

function threadHistoryTextLength(state: unknown, index: number): number {
  const snapshot = threadSnapshot(state);
  const message = snapshot.history[index];
  if (!isTextMessage(message)) {
    throw new Error(`missing text message at index ${index}`);
  }
  return message.content.length;
}

type EventSummary =
  | { readonly textLength: number; readonly type: "assistant-text" }
  | { readonly outputLength: number; readonly type: "tool-result" };

interface TextMessageProbe {
  readonly content: string;
}

interface TextOutputProbe {
  readonly text: string;
}

interface ThreadSnapshotProbe {
  readonly history: readonly unknown[];
}

function threadSnapshot(value: unknown): ThreadSnapshotProbe {
  if (!isThreadSnapshot(value)) {
    throw new Error("stored thread is not a snapshot");
  }
  return value;
}

function isThreadSnapshot(value: unknown): value is ThreadSnapshotProbe {
  return (
    value !== null &&
    typeof value === "object" &&
    "history" in value &&
    Array.isArray(value.history)
  );
}

function isTextMessage(value: unknown): value is TextMessageProbe {
  return (
    value !== null &&
    typeof value === "object" &&
    "content" in value &&
    typeof value.content === "string"
  );
}

function eventSummary(event: AgentEvent): EventSummary {
  if (event.type === "assistant-text") {
    return { textLength: event.text.length, type: "assistant-text" };
  }
  if (event.type === "tool-result" && isTextOutput(event.output)) {
    return { outputLength: event.output.text.length, type: "tool-result" };
  }
  throw new Error(`unexpected oversized event ${event.type}`);
}

function isTextOutput(value: unknown): value is TextOutputProbe {
  return (
    value !== null &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

async function timed<T>(
  timings: StorageLatencyTiming[],
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  timings.push({ label, ms: performance.now() - start });
  return result;
}
