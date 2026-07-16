import type {
  AgentHost,
  TurnRecord,
  TurnStatus,
} from "../../execution/host/types";
import type { RuntimeToolExecutionContext } from "../../llm/llm";
import type { PluginRuntime } from "../../plugins/runtime";
import type { ThreadState } from "../state/thread-state";
import type { ThreadAutoCompactionOptions } from "./auto-compaction";
import {
  createThreadToolExecutionContext,
  type ThreadToolCallInterceptor,
  type ThreadToolResultInterceptor,
} from "./execution-checkpoints";

export interface ThreadExecutionOptions {
  readonly autoCompaction?: ThreadAutoCompactionOptions;
  readonly executionHost?: AgentHost;
  readonly pluginRuntime?: PluginRuntime;
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

export async function startThreadExecutionRun({
  executionHost,
  interceptToolCall,
  interceptToolResult,
  threadKey,
  state,
  turnId,
}: {
  readonly executionHost?: AgentHost;
  readonly interceptToolCall?: ThreadToolCallInterceptor;
  readonly interceptToolResult?: ThreadToolResultInterceptor;
  readonly threadKey: string;
  readonly state: ThreadState;
  readonly turnId: string;
}): Promise<ThreadExecutionRun | undefined> {
  if (!executionHost) {
    return;
  }

  const runId = `turn:${threadKey}:${turnId}`;
  const run: TurnRecord = {
    checkpointVersion: 0,
    dedupeKey: runId,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey,
    status: "running",
  };
  await executionHost.store.turns.create(run);

  return {
    complete: (status) =>
      completeThreadExecutionRun({ executionHost, runId, status }),
    runId,
    toolExecution: createThreadToolExecutionContext({
      executionHost,
      interceptToolCall,
      interceptToolResult,
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
  readonly executionHost: AgentHost;
  readonly runId: string;
  readonly status: ThreadExecutionTerminalStatus;
}): Promise<void> {
  const run = await executionHost.store.turns.get(runId);
  if (!run) {
    return;
  }

  await executionHost.store.turns.update({ ...run, status });
}
