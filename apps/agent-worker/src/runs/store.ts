import type { AgentEvent } from "@minpeter/pss-runtime";
import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import type { WorkerRoute } from "../request/route";
import type { StressScenarioEvidence } from "../scenarios/evidence";
import type { EventSummary } from "../scenarios/metrics";
import type { StressScenarioResult } from "../scenarios/result";

const runCounterStorageKey = "__pss_worker_run_counter";
const runStoragePrefix = "__pss_worker_run";

export interface RunEnvelope {
  readonly result: StressScenarioResult;
  readonly route: WorkerRoute;
  readonly runId: string;
  readonly status: "completed";
}

export interface RunEventsEnvelope {
  readonly events: readonly AgentEvent[];
  readonly evidence?: StressScenarioEvidence;
  readonly markers: readonly string[];
  readonly runId: string;
  readonly summary: EventSummary;
}

export async function recordCompletedRun(
  storage: CloudflareDurableObjectStorage,
  route: WorkerRoute,
  result: StressScenarioResult
): Promise<RunEnvelope> {
  return await transact(storage, async (transactionStorage) => {
    const nextCounter =
      ((await transactionStorage.get<number>(runCounterStorageKey)) ?? 0) + 1;
    const runId = runIdFromCounter(nextCounter);
    const envelope: RunEnvelope = {
      result,
      route,
      runId,
      status: "completed",
    };

    await transactionStorage.put(runCounterStorageKey, nextCounter);
    await transactionStorage.put(runStorageKey(runId), envelope);
    return envelope;
  });
}

export async function readRun(
  storage: CloudflareDurableObjectStorage,
  runId: string
): Promise<RunEnvelope | undefined> {
  return await storage.get<RunEnvelope>(runStorageKey(runId));
}

export async function readRunEvents(
  storage: CloudflareDurableObjectStorage,
  runId: string
): Promise<RunEventsEnvelope | undefined> {
  const envelope = await readRun(storage, runId);
  if (!envelope) {
    return;
  }
  const events: RunEventsEnvelope = {
    events: envelope.result.events,
    markers: envelope.result.markers,
    runId,
    summary: envelope.result.summary,
  };
  if (envelope.result.evidence) {
    return { ...events, evidence: envelope.result.evidence };
  }
  return events;
}

async function transact<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectStorage) => Promise<T>
): Promise<T> {
  if (storage.transaction) {
    return await storage.transaction(fn);
  }
  return await fn(storage);
}

function runIdFromCounter(counter: number): string {
  return `run_${counter.toString().padStart(4, "0")}`;
}

function runStorageKey(runId: string): string {
  return `${runStoragePrefix}:${runId}`;
}
