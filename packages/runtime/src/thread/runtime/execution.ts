import type {
  ExecutionHost,
  RunRecord,
  RunStatus,
} from "../../execution/host/types";
import type { RuntimeToolExecutionContext } from "../../llm/llm";
import type { ThreadState } from "../state/thread-state";
import { createThreadToolExecutionContext } from "./execution-checkpoints";

export interface ThreadExecutionOptions {
  readonly executionHost?: ExecutionHost;
}

export interface ThreadExecutionRun {
  complete(status: ThreadExecutionTerminalStatus): Promise<void>;
  readonly runId: string;
  readonly toolExecution: RuntimeToolExecutionContext;
}

export type ThreadExecutionTerminalStatus = Extract<
  RunStatus,
  "cancelled" | "completed" | "error" | "needs-recovery"
>;

export async function startThreadExecutionRun({
  executionHost,
  threadKey,
  state,
  turnId,
}: {
  readonly executionHost?: ExecutionHost;
  readonly threadKey: string;
  readonly state: ThreadState;
  readonly turnId: string;
}): Promise<ThreadExecutionRun | undefined> {
  if (!executionHost) {
    return;
  }

  const runId = `turn:${threadKey}:${turnId}`;
  const run: RunRecord = {
    checkpointVersion: 0,
    dedupeKey: runId,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey,
    status: "running",
  };
  await executionHost.store.runs.create(run);

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

async function completeThreadExecutionRun({
  executionHost,
  runId,
  status,
}: {
  readonly executionHost: ExecutionHost;
  readonly runId: string;
  readonly status: ThreadExecutionTerminalStatus;
}): Promise<void> {
  const run = await executionHost.store.runs.get(runId);
  if (!run) {
    return;
  }

  await executionHost.store.runs.update({ ...run, status });
}
