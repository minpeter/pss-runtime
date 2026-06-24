import type {
  ExecutionHost,
  TurnKind,
  TurnRecord,
  TurnStatus,
} from "../../execution/host/types";
import type { RuntimeToolExecutionContext } from "../../llm/llm";
import type { QueuedExecutionRun } from "../input/runtime-input";
import type { ThreadState } from "../state/thread-state";
import type { ThreadAutoCompactionOptions } from "./auto-compaction";
import { createThreadToolExecutionContext } from "./execution-checkpoints";

export interface ThreadExecutionOptions {
  readonly autoCompaction?: ThreadAutoCompactionOptions;
  readonly executionHost?: ExecutionHost;
}

export interface ThreadExecutionRun {
  complete(status: ThreadExecutionTerminalStatus): Promise<void>;
  readonly runId: string;
  readonly toolExecution: RuntimeToolExecutionContext;
}

export type ThreadExecutionTerminalStatus = Extract<
  TurnStatus,
  "cancelled" | "completed" | "error" | "needs-recovery"
>;

export async function precreateThreadExecutionRun({
  executionHost,
  kind,
  threadKey,
}: {
  readonly executionHost?: ExecutionHost;
  readonly kind: TurnKind;
  readonly threadKey: string;
}): Promise<TurnRecord | undefined> {
  if (!executionHost) {
    return;
  }

  const runId = `turn:${threadKey}:${crypto.randomUUID()}`;
  const run = createThreadExecutionRunRecord({
    kind,
    runId,
    status: "queued",
    threadKey,
  });
  const created = await executionHost.store.turns.create(run);
  return created.record;
}

export async function startThreadExecutionRun({
  executionRun,
  executionHost,
  threadKey,
  state,
  turnId,
}: {
  readonly executionRun?: QueuedExecutionRun;
  readonly executionHost?: ExecutionHost;
  readonly threadKey: string;
  readonly state: ThreadState;
  readonly turnId: string;
}): Promise<ThreadExecutionRun | undefined> {
  if (!executionHost) {
    return;
  }

  const runId = executionRun?.runId ?? `turn:${threadKey}:${turnId}`;
  const kind = executionRun?.kind ?? "user-turn";
  const existingRun = executionRun
    ? await executionHost.store.turns.get(executionRun.runId)
    : null;
  if (existingRun) {
    if (!isTerminalTurnStatus(existingRun.status)) {
      await executionHost.store.turns.update({
        ...existingRun,
        status: "running",
      });
    }
  } else {
    await executionHost.store.turns.create(
      createThreadExecutionRunRecord({
        kind,
        runId,
        status: "running",
        threadKey,
      })
    );
  }

  return {
    complete: (status) =>
      completeThreadExecutionRun({ executionHost, runId, status }),
    runId,
    toolExecution: createThreadToolExecutionContext({
      executionHost,
      runId,
      state,
    }),
  };
}

export async function cancelThreadExecutionRun({
  executionHost,
  executionRun,
  runId,
}: {
  readonly executionHost?: ExecutionHost;
  readonly executionRun?: QueuedExecutionRun;
  readonly runId?: string;
}): Promise<void> {
  const targetRunId = runId ?? executionRun?.runId;
  if (!(executionHost && targetRunId)) {
    return;
  }

  const run = await executionHost.store.turns.get(targetRunId);
  if (!run || isTerminalTurnStatus(run.status)) {
    return;
  }

  await executionHost.store.turns.update({ ...run, status: "cancelled" });
}

function createThreadExecutionRunRecord({
  kind,
  runId,
  status,
  threadKey,
}: {
  readonly kind: TurnKind;
  readonly runId: string;
  readonly status: Extract<TurnStatus, "queued" | "running">;
  readonly threadKey: string;
}): TurnRecord {
  return {
    checkpointVersion: 0,
    dedupeKey: runId,
    kind,
    rootRunId: runId,
    runId,
    threadKey,
    status,
  };
}

async function completeThreadExecutionRun({
  executionHost,
  runId,
  status,
}: {
  readonly executionHost: ExecutionHost;
  readonly runId: string;
  readonly status: ThreadExecutionTerminalStatus;
}): Promise<void> {
  const run = await executionHost.store.turns.get(runId);
  if (!run) {
    return;
  }
  if (isTerminalTurnStatus(run.status)) {
    return;
  }

  await executionHost.store.turns.update({ ...run, status });
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
  return (
    status === "cancelled" ||
    status === "completed" ||
    status === "error" ||
    status === "needs-recovery"
  );
}
