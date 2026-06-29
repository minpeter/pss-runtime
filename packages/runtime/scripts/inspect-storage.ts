import type {
  ExecutionHost,
  NotificationRecord,
  RunCheckpoint,
  RunRecord,
} from "../src/execution";
import {
  createCloudflareDurableObjectHost,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../src/platform/cloudflare/host/durable-object-host";
import { InMemorySqlStorage } from "../src/platform/cloudflare/sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../src/platform/cloudflare/storage/durable-object/durable-object-storage";
import type { StorageLatencyTiming } from "../src/platform/cloudflare/storage/execution/storage-metrics";
import type { AgentEvent } from "../src/thread/protocol/events";
import {
  preview,
  printApiMap,
  printLatencySummary,
  printSection,
  printStorageMetrics,
  printTableCounts,
  printTableSamples,
} from "./storage-inspect-output";

interface DemoIds {
  readonly idempotencyKey: string;
  readonly notificationId: string;
  readonly runId: string;
  readonly threadKey: string;
}

const prefix = "inspect-runtime-storage";
const ids: DemoIds = {
  idempotencyKey: "notify:demo-run-1",
  notificationId: "notification-1",
  runId: "run-1",
  threadKey: "agent:demo-agent/user:user-42/thread:main",
};

const sql = new InMemorySqlStorage();
const storage = new InMemoryCloudflareDurableObjectStorage({ sql });
const host = createCloudflareDurableObjectHost({
  maxPayloadBytes: 64_000,
  prefix,
  storage,
});
const timings: StorageLatencyTiming[] = [];

await timed(timings, "write demo scenario", () => writeDemoScenario(host));
printApiMap();
printTableCounts(sql);
printStorageMetrics(sql);
printLatencySummary(timings);
printTableSamples(sql);
await printLoadResults(host);

async function writeDemoScenario(runtimeHost: ExecutionHost): Promise<void> {
  await runtimeHost.store.threads.commit(
    ids.threadKey,
    {
      state: {
        history: [
          { content: "내 이번 주문 상태 알려줘", role: "user" },
          { content: "확인해볼게요.", role: "assistant" },
          { content: "긴 입력 ".repeat(24_000), role: "user" },
        ],
        schemaVersion: 1,
      },
    },
    { expectedVersion: null }
  );

  const run: RunRecord = {
    checkpointVersion: 0,
    kind: "thread-turn",
    ownerNamespace: "demo-agent",
    rootRunId: ids.runId,
    runId: ids.runId,
    status: "queued",
    threadKey: ids.threadKey,
  };
  await runtimeHost.store.runs.create(run);

  const events: readonly AgentEvent[] = [
    { type: "turn-start" },
    { type: "step-start" },
    {
      text: "주문 조회를 위해 내부 도구를 호출합니다.",
      type: "assistant-output",
    },
    {
      input: { orderId: "order-123" },
      toolCallId: "tool-call-1",
      toolName: "lookupOrder",
      type: "tool-call",
    },
    {
      output: {
        details: "큰 도구 결과 ".repeat(12_000),
        eta: "tomorrow",
        status: "shipping",
      },
      toolCallId: "tool-call-1",
      toolName: "lookupOrder",
      type: "tool-result",
    },
    { type: "step-end" },
    { type: "turn-end" },
  ];
  for (const event of events) {
    await runtimeHost.store.events.append(ids.runId, event);
  }

  const checkpoint: RunCheckpoint = {
    checkpointId: "checkpoint-1",
    phase: "after-tool",
    runId: ids.runId,
    runtimeState: { nextStep: "final-answer", toolCallId: "tool-call-1" },
    threadSnapshot: { threadKey: ids.threadKey, version: "1" },
    version: 1,
  };
  await runtimeHost.store.checkpoints.append(checkpoint, {
    expectedVersion: 0,
  });
  await runtimeHost.store.runs.update({
    ...run,
    checkpointVersion: 1,
    status: "suspended",
  });

  const notification: NotificationRecord = {
    idempotencyKey: ids.idempotencyKey,
    input: {
      text: "배송 알림이 들어왔어. 이어서 처리해줘.",
      type: "user-input",
    },
    notificationId: ids.notificationId,
    ownerNamespace: "demo-agent",
    runId: "notification-run-1",
    status: "pending",
    threadKey: ids.threadKey,
  };
  await runtimeHost.store.notifications.enqueue(notification);
  await runtimeHost.scheduler.enqueueRun(ids.runId);
  await runtimeHost.scheduler.resumeThread(ids.threadKey, {
    idempotencyKey: ids.idempotencyKey,
    notificationId: ids.notificationId,
    runId: notification.runId,
  });
}

async function printLoadResults(runtimeHost: ExecutionHost): Promise<void> {
  printSection("Load/read results");
  const thread = await runtimeHost.store.threads.load(ids.threadKey);
  console.log(`threads.load(${ids.threadKey})`);
  console.log(`  version: ${thread?.version ?? "null"}`);
  console.log(`  history length: ${historyLength(thread?.state) ?? "unknown"}`);
  console.log(`  state preview: ${preview(thread?.state, 220)}`);

  const run = await runtimeHost.store.runs.get(ids.runId);
  console.log(`runs.get(${ids.runId})`);
  console.log(`  ${preview(run, 220)}`);

  const eventTypes: string[] = [];
  for await (const event of runtimeHost.store.events.read(ids.runId)) {
    eventTypes.push(`${event.cursor.offset}:${event.event.type}`);
  }
  console.log(`events.read(${ids.runId})`);
  console.log(`  ${eventTypes.join(" -> ")}`);

  const checkpoint = await runtimeHost.store.checkpoints.latest(ids.runId);
  console.log(`checkpoints.latest(${ids.runId})`);
  console.log(`  ${preview(checkpoint, 220)}`);

  const notification =
    await runtimeHost.store.notifications.claimByIdempotencyKey(
      ids.idempotencyKey
    );
  console.log(`notifications.claimByIdempotencyKey(${ids.idempotencyKey})`);
  console.log(`  ${preview(notification, 220)}`);

  const scheduledRuns = await listScheduledCloudflareRuns(storage, { prefix });
  const scheduledPrompts = await listScheduledCloudflareThreadPrompts(storage, {
    prefix,
  });
  console.log("scheduled work lists");
  console.log(`  runs: ${preview(scheduledRuns, 180)}`);
  console.log(`  thread prompts: ${preview(scheduledPrompts, 220)}`);
}

function historyLength(state: unknown): number | null {
  if (typeof state !== "object" || state === null || !("history" in state)) {
    return null;
  }
  return Array.isArray(state.history) ? state.history.length : null;
}

async function timed<T>(
  timingRows: StorageLatencyTiming[],
  label: string,
  action: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  const result = await action();
  timingRows.push({ label, ms: performance.now() - start });
  return result;
}
