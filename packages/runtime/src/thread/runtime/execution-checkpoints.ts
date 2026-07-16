import { createCheckpointId } from "../../execution/host/checkpoint-ids";
import type { AgentHost, CheckpointPhase } from "../../execution/host/types";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/llm";
import { persistedToolExecutionCheckpoint } from "../../llm/tool-execution";
import type { ThreadState } from "../state/thread-state";

const maxCheckpointWriteAttempts = 5;

export type ThreadToolCallInterceptor = (
  checkpoint: RuntimeToolExecutionCheckpoint
) => Promise<RuntimeToolExecutionDecision> | RuntimeToolExecutionDecision;

export type ThreadToolResultInterceptor = (
  checkpoint: RuntimeToolExecutionCheckpoint & { readonly output: unknown }
) =>
  | Promise<RuntimeToolExecutionResult | undefined>
  | RuntimeToolExecutionResult
  | undefined;

export class ThreadExecutionCheckpointError extends Error {
  constructor(runId: string, expectedVersion: number, currentVersion: number) {
    super(
      `Thread execution run ${runId} checkpoint conflict: expected ${expectedVersion}, got ${currentVersion}`
    );
    this.name = "ThreadExecutionCheckpointError";
  }
}

export function createThreadToolExecutionContext({
  executionHost,
  interceptToolCall,
  interceptToolResult,
  runId,
  state,
}: {
  readonly executionHost: AgentHost;
  readonly interceptToolCall?: ThreadToolCallInterceptor;
  readonly interceptToolResult?: ThreadToolResultInterceptor;
  readonly runId: string;
  readonly state: ThreadState;
}): RuntimeToolExecutionContext {
  return {
    attempt: 1,
    afterTool: async (checkpoint) => {
      await appendThreadToolExecutionCheckpoint({
        executionHost,
        phase: "after-tool",
        runId,
        state,
        toolCall: checkpoint,
      });
      return await interceptToolResult?.(checkpoint);
    },
    beforeTool: async (checkpoint) => {
      await appendThreadToolExecutionCheckpoint({
        executionHost,
        phase: "before-tool",
        runId,
        state,
        toolCall: checkpoint,
      });
      const decision = await interceptToolCall?.(checkpoint);
      if (
        decision?.status === "needs-recovery" &&
        checkpoint.policy !== "manual-recovery"
      ) {
        await appendThreadToolExecutionCheckpoint({
          executionHost,
          phase: "before-tool",
          runId,
          state,
          toolCall: { ...checkpoint, policy: "manual-recovery" },
        });
      }
      return decision;
    },
    runId,
  };
}

async function appendThreadToolExecutionCheckpoint({
  executionHost,
  phase,
  runId,
  state,
  toolCall,
}: {
  readonly executionHost: AgentHost;
  readonly phase: Extract<CheckpointPhase, "after-tool" | "before-tool">;
  readonly runId: string;
  readonly state: ThreadState;
  readonly toolCall: RuntimeToolExecutionCheckpoint & {
    readonly output?: unknown;
  };
}): Promise<void> {
  let lastConflict:
    | { readonly current: number; readonly expected: number }
    | undefined;
  for (let attempt = 0; attempt < maxCheckpointWriteAttempts; attempt += 1) {
    const run = await executionHost.store.turns.get(runId);
    if (!run) {
      throw new Error(`Thread execution run ${runId} is missing.`);
    }

    const version = run.checkpointVersion + 1;
    const result = await executionHost.store.checkpoints.append(
      {
        checkpointId: createCheckpointId({ phase, runId, version }),
        pendingToolCall: persistedToolExecutionCheckpoint(toolCall),
        phase,
        runId,
        runtimeState: {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
        threadSnapshot: state.threadCheckpointReference(),
        version,
      },
      { expectedVersion: run.checkpointVersion }
    );

    if (result.ok) {
      return;
    }

    lastConflict = {
      current: result.currentVersion,
      expected: run.checkpointVersion,
    };
  }

  throw new ThreadExecutionCheckpointError(
    runId,
    lastConflict?.expected ?? 0,
    lastConflict?.current ?? 0
  );
}
