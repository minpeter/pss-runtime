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
   * Tool-result parts with this id in the in-memory model history when the
   * result was checkpointed, before the result itself was appended. Provider
   * ids can recur, so the result counts as committed only when committed
   * history holds more. `undefined` means no evidence: unrestorable.
   */
  readonly priorResultCount?: number;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** Recovery evidence recorded on a before-tool or after-tool checkpoint. */
export interface ToolCheckpointEvidence {
  /** Calls completed earlier in the run; `undefined` if never recorded. */
  readonly priorCompleted: readonly CompletedToolCall[] | undefined;
  /** The checkpoint's own call; `priorResultCount` only on after-tool. */
  readonly toolCall: CompletedToolCall;
}

type CompletedToolCallFields = Partial<
  Record<keyof CompletedToolCall | "priorCompletedToolCalls", unknown>
>;

function parseCompletedToolCall(
  entry: CompletedToolCallFields | null | undefined
): CompletedToolCall | undefined {
  if (
    !(
      typeof entry?.toolCallId === "string" &&
      typeof entry.toolName === "string"
    )
  ) {
    return;
  }
  return {
    ...(typeof entry.checkpointVersion === "number"
      ? { checkpointVersion: entry.checkpointVersion }
      : {}),
    ...(typeof entry.priorResultCount === "number"
      ? { priorResultCount: entry.priorResultCount }
      : {}),
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
  };
}

/** Evidence of a tool checkpoint; `undefined` for any other checkpoint. */
export function toolCheckpointEvidence(
  checkpoint: Checkpoint | null
): ToolCheckpointEvidence | undefined {
  if (
    checkpoint?.phase !== "before-tool" &&
    checkpoint?.phase !== "after-tool"
  ) {
    return;
  }
  const state = checkpoint.runtimeState as CompletedToolCallFields | null;
  const prior = state?.priorCompletedToolCalls;
  const pending = checkpoint.pendingToolCall as
    | CompletedToolCallFields
    | undefined;
  const own = parseCompletedToolCall(state) ??
    parseCompletedToolCall(pending) ?? {
      toolCallId: "unknown",
      toolName: "unknown",
    };
  return {
    priorCompleted: Array.isArray(prior)
      ? prior.map(
          (entry: unknown): CompletedToolCall =>
            // An unparseable entry still marks a completed call; keep it as
            // unrestorable rather than dropping it.
            parseCompletedToolCall(entry as CompletedToolCallFields | null) ?? {
              toolCallId: "unknown",
              toolName: "unknown",
            }
        )
      : undefined,
    toolCall:
      checkpoint.phase === "after-tool"
        ? { ...own, checkpointVersion: checkpoint.version }
        : {
            toolCallId: own.toolCallId,
            toolName: own.toolName,
          },
  };
}

function completedToolCallsThrough(
  checkpoint: Checkpoint | null
): CompletedToolCall[] {
  const evidence = toolCheckpointEvidence(checkpoint);
  if (!evidence) {
    return [];
  }
  return [
    ...(evidence.priorCompleted ?? []),
    ...(checkpoint?.phase === "after-tool" ? [evidence.toolCall] : []),
  ];
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
  // The current call's result joins history only at step end, so this counts
  // only same-id results from earlier steps and turns.
  const priorResultCount =
    phase === "after-tool"
      ? state.history.toolResultCount(toolCall.toolCallId)
      : undefined;
  let lastConflict:
    | { readonly current: number; readonly expected: number }
    | undefined;
  for (let attempt = 0; attempt < maxCheckpointWriteAttempts; attempt += 1) {
    const run = await executionHost.store.turns.get(runId);
    if (!run) {
      throw new Error(`Thread execution run ${runId} is missing.`);
    }

    const version = run.checkpointVersion + 1;
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
          ...(priorResultCount === undefined ? {} : { priorResultCount }),
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
        threadSnapshot: state.threadCheckpointReference(),
        version,
      },
      {
        expectedLeaseId: leaseId,
        expectedVersion: run.checkpointVersion,
      }
    );

    if (result.ok) {
      if (priorResultCount !== undefined) {
        completed.push({
          checkpointVersion: version,
          priorResultCount,
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
