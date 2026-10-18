import { appendLeaseFencedCheckpoint } from "../../execution/host/checkpoint-fencing";
import { createCheckpointId } from "../../execution/host/checkpoint-ids";
import type {
  AgentHost,
  Checkpoint,
  CheckpointPhase,
  LeaseFencedCheckpointWriteResult,
} from "../../execution/host/types";
import { assertNever } from "../../internal/guards";
import { persistedToolExecutionCheckpoint } from "../../llm/tool-execution-checkpoint";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
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

type CheckpointAuthorityConflictReason = Exclude<
  Extract<LeaseFencedCheckpointWriteResult, { readonly ok: false }>["reason"],
  "stale-version"
>;

const CHECKPOINT_AUTHORITY_CONFLICT_MESSAGES = {
  "lease-conflict": "checkpoint lease conflict.",
  "not-found": "checkpoint run is missing.",
  "status-conflict": "checkpoint status conflict: run is terminal.",
} as const satisfies Record<CheckpointAuthorityConflictReason, string>;

export class ThreadExecutionCheckpointAuthorityError extends Error {
  readonly reason: CheckpointAuthorityConflictReason;
  readonly runId: string;

  constructor(runId: string, reason: CheckpointAuthorityConflictReason) {
    super(
      `Thread execution run ${runId} ${CHECKPOINT_AUTHORITY_CONFLICT_MESSAGES[reason]}`
    );
    this.name = "ThreadExecutionCheckpointAuthorityError";
    this.reason = reason;
    this.runId = runId;
  }
}

/** A tool call whose after-tool checkpoint was persisted earlier in a run. */
export interface CompletedToolCall {
  /** Run checkpoint version of the after-tool checkpoint; unique per run. */
  readonly checkpointVersion?: number;
  /**
   * Committed thread version when the result was checkpointed. A thread
   * commit after it is required before the result counts as committed;
   * `undefined` means it was not recorded and the result is unrestorable.
   */
  readonly threadVersion?: string | null;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** Tool calls a tool checkpoint records as completed before its own call. */
export function priorCompletedToolCalls(
  checkpoint: Checkpoint | null
): CompletedToolCall[] {
  const state = checkpoint?.runtimeState as
    | { readonly priorCompletedToolCalls?: unknown }
    | null
    | undefined;
  const prior = state?.priorCompletedToolCalls;
  if (!Array.isArray(prior)) {
    return [];
  }
  return prior.flatMap((entry: unknown): CompletedToolCall[] => {
    const call = entry as Partial<Record<keyof CompletedToolCall, unknown>>;
    if (
      !(
        typeof call?.toolCallId === "string" &&
        typeof call.toolName === "string"
      )
    ) {
      return [];
    }
    return [
      {
        ...(typeof call.checkpointVersion === "number"
          ? { checkpointVersion: call.checkpointVersion }
          : {}),
        ...(typeof call.threadVersion === "string" ||
        call.threadVersion === null
          ? { threadVersion: call.threadVersion }
          : {}),
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      },
    ];
  });
}

/**
 * Committed thread version a checkpoint was written against; `undefined`
 * when the checkpoint did not record one.
 */
export function recordedThreadVersion(
  checkpoint: Checkpoint | null
): string | null | undefined {
  const snapshot = checkpoint?.threadSnapshot as
    | { readonly threadVersion?: unknown }
    | null
    | undefined;
  const version = snapshot?.threadVersion;
  return typeof version === "string" || version === null ? version : undefined;
}

function completedToolCallsThrough(
  checkpoint: Checkpoint | null
): CompletedToolCall[] {
  const completed = priorCompletedToolCalls(checkpoint);
  const state = checkpoint?.runtimeState as
    | Partial<Record<keyof CompletedToolCall, unknown>>
    | null
    | undefined;
  if (
    checkpoint?.phase === "after-tool" &&
    typeof state?.toolCallId === "string" &&
    typeof state.toolName === "string"
  ) {
    const threadVersion = recordedThreadVersion(checkpoint);
    completed.push({
      checkpointVersion: checkpoint.version,
      ...(threadVersion === undefined ? {} : { threadVersion }),
      toolCallId: state.toolCallId,
      toolName: state.toolName,
    });
  }
  return completed;
}

export function createThreadToolExecutionContext({
  executionHost,
  interceptToolCall,
  interceptToolResult,
  leaseId,
  runId,
  state,
}: {
  readonly executionHost: AgentHost;
  readonly interceptToolCall?: ThreadToolCallInterceptor;
  readonly interceptToolResult?: ThreadToolResultInterceptor;
  readonly leaseId: string | null;
  readonly runId: string;
  readonly state: ThreadState;
}): RuntimeToolExecutionContext {
  // Thread history is committed only at input, steer, and turn end, so every
  // tool checkpoint records the run's earlier completed tools. Recovery that
  // can restore only the latest checkpoint uses this to fail closed. A
  // recovered attempt inherits the list from the run's latest checkpoint.
  // Appends are serialized so parallel tool calls in one step each record
  // every sibling whose result was checkpointed before them.
  let completed: CompletedToolCall[] | undefined;
  let appends: Promise<unknown> = Promise.resolve();
  const append = (
    phase: Extract<CheckpointPhase, "after-tool" | "before-tool">,
    toolCall: RuntimeToolExecutionCheckpoint & { readonly output?: unknown }
  ): Promise<void> => {
    const appended = appends.then(async () => {
      completed ??= completedToolCallsThrough(
        await executionHost.store.checkpoints.latest(runId)
      );
      await appendThreadToolExecutionCheckpoint({
        completed,
        executionHost,
        leaseId,
        phase,
        runId,
        state,
        toolCall,
      });
    });
    // A failed append rejects only its own caller, never later appends.
    appends = appended.catch(() => undefined);
    return appended;
  };
  return {
    attempt: 1,
    afterTool: async (checkpoint) => {
      // Recovered results never pass the result hook again, so persist only
      // its final output. A crash inside the hook leaves before-tool latest.
      const transformed = await interceptToolResult?.(checkpoint);
      await append("after-tool", {
        ...checkpoint,
        output: transformed ? transformed.output : checkpoint.output,
      });
      return transformed;
    },
    beforeTool: async (checkpoint) => {
      await append("before-tool", checkpoint);
      const decision = await interceptToolCall?.(checkpoint);
      if (
        decision?.status === "needs-recovery" &&
        checkpoint.policy !== "manual-recovery"
      ) {
        await append("before-tool", {
          ...checkpoint,
          policy: "manual-recovery",
        });
      }
      return decision;
    },
    runId,
  };
}

async function appendThreadToolExecutionCheckpoint({
  completed,
  executionHost,
  leaseId,
  phase,
  runId,
  state,
  toolCall,
}: {
  readonly completed: CompletedToolCall[];
  readonly executionHost: AgentHost;
  readonly leaseId: string | null;
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
    const threadSnapshot = state.threadCheckpointReference();
    const result = await appendLeaseFencedCheckpoint(
      executionHost.store,
      {
        checkpointId: createCheckpointId({ phase, runId, version }),
        pendingToolCall: persistedToolExecutionCheckpoint(toolCall),
        phase,
        runId,
        runtimeState: {
          ...(phase === "after-tool" ? cloneToolCallState(toolCall) : {}),
          priorCompletedToolCalls: [...completed],
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
        threadSnapshot,
        version,
      },
      {
        expectedLeaseId: leaseId,
        expectedVersion: run.checkpointVersion,
      }
    );

    if (result.ok) {
      if (phase === "after-tool") {
        completed.push({
          checkpointVersion: version,
          threadVersion: threadSnapshot.threadVersion,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        });
      }
      return;
    }

    switch (result.reason) {
      case "lease-conflict":
      case "not-found":
      case "status-conflict":
        throw new ThreadExecutionCheckpointAuthorityError(runId, result.reason);
      case "stale-version":
        lastConflict = {
          current: result.currentVersion,
          expected: run.checkpointVersion,
        };
        // Another writer advanced the run; keep its completed tools too.
        mergeCompletedToolCalls(
          completed,
          completedToolCallsThrough(
            await executionHost.store.checkpoints.latest(runId)
          )
        );
        break;
      default:
        assertNever(result);
    }
  }

  throw new ThreadExecutionCheckpointError(
    runId,
    lastConflict?.expected ?? 0,
    lastConflict?.current ?? 0
  );
}

// Provider tool call ids can recur, so the after-tool checkpoint version
// identifies a completion.
function mergeCompletedToolCalls(
  completed: CompletedToolCall[],
  calls: readonly CompletedToolCall[]
): void {
  for (const call of calls) {
    if (
      !completed.some(
        (known) =>
          known.checkpointVersion === call.checkpointVersion &&
          known.toolCallId === call.toolCallId
      )
    ) {
      completed.push(call);
    }
  }
}

function cloneToolCallState(toolCall: {
  readonly input: unknown;
  readonly output?: unknown;
}): {
  readonly hasOutput: true;
  readonly input: unknown;
  readonly output: unknown;
} {
  return {
    hasOutput: true,
    input: structuredClone(toolCall.input ?? {}),
    output:
      toolCall.output === undefined ? null : structuredClone(toolCall.output),
  };
}
