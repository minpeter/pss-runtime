import { createCheckpointId } from "../../execution/host/checkpoint-ids";
import {
  awaitsRecoveryDecision,
  type PendingToolCall,
  pendingToolCalls,
  type ToolRecoveryDecision,
  toolStepJournal,
} from "../../execution/host/tool-step-journal";
import { transitionTurn } from "../../execution/host/turn-status";
import type {
  AgentHost,
  Checkpoint,
  HostStoreTransaction,
} from "../../execution/host/types";
import { assertNever } from "../../internal/guards";
import { isRecordClaimableByAgent } from "../../thread/handle/agent-thread-continuation";

/** Decisions for a parked run's tool calls whose outcome is unknown. */
export interface RecoveryResolution {
  /** Decision for each call awaiting one that `toolCalls` does not list. */
  readonly otherwise?: ToolRecoveryDecision;
  /**
   * Decisions keyed by tool call id. Any unfinished call may be listed,
   * which overrides its retry policy.
   */
  readonly toolCalls?: Readonly<Record<string, ToolRecoveryDecision>>;
}

export type RecoveryResolutionErrorReason =
  | "conflict"
  | "not-found"
  | "not-parked"
  | "undecided"
  | "unknown-tool-call"
  | "unsupported";

const REASON_MESSAGES = {
  conflict: "changed while its recovery was being recorded",
  "not-found": "was not found",
  "not-parked": "is not waiting for recovery",
  undecided: "has unfinished tool calls without a decision",
  "unknown-tool-call": "has no unfinished tool call with that id",
  unsupported: "was checkpointed in a format that cannot record decisions",
} as const satisfies Record<RecoveryResolutionErrorReason, string>;

/** Rejects `agent.resolveRecovery()`; nothing was recorded. */
export class RecoveryResolutionError extends Error {
  readonly reason: RecoveryResolutionErrorReason;
  readonly runId: string;
  /** The calls the reason concerns, when it concerns calls. */
  readonly toolCallIds: readonly string[];

  constructor(
    runId: string,
    reason: RecoveryResolutionErrorReason,
    toolCallIds: readonly string[] = []
  ) {
    super(
      `Thread execution run ${runId} ${REASON_MESSAGES[reason]}${
        toolCallIds.length > 0 ? `: ${toolCallIds.join(", ")}` : ""
      }.`
    );
    this.name = "RecoveryResolutionError";
    this.reason = reason;
    this.runId = runId;
    this.toolCallIds = toolCallIds;
  }
}

/**
 * Records decisions for a `needs-recovery` run's unfinished tool calls and
 * requeues it; `agent.resume(runId)` or `thread.continue()` then settles each
 * call before the model runs. A run parked without such calls (repeated
 * crashes) is requeued as is. Requeueing cannot restore completed results
 * that are missing from committed history; such a run parks again on resume.
 */
export async function resolveAgentRecovery({
  hasExplicitNamespace,
  host,
  ownerNamespace,
  resolution,
  runId,
}: {
  readonly hasExplicitNamespace: boolean;
  readonly host: AgentHost;
  readonly ownerNamespace: string;
  readonly resolution: RecoveryResolution;
  readonly runId: string;
}): Promise<void> {
  // Decisions are stored as JSON, so validate and copy them before writing.
  const decisions = new Map(
    Object.entries(resolution.toolCalls ?? {}).map(([id, decision]) => [
      id,
      storedDecision(decision),
    ])
  );
  const otherwise = resolution.otherwise
    ? storedDecision(resolution.otherwise)
    : undefined;
  await host.store.transaction(async (transaction) => {
    const run = await transaction.turns.get(runId);
    if (
      !(
        run &&
        (run.kind === "user-turn" || run.kind === "tool-recovery") &&
        isRecordClaimableByAgent(run, ownerNamespace, hasExplicitNamespace)
      )
    ) {
      throw new RecoveryResolutionError(runId, "not-found");
    }
    if (run.status !== "needs-recovery") {
      throw new RecoveryResolutionError(runId, "not-parked");
    }
    const latest = await transaction.checkpoints.latest(runId);
    const decided = decideToolCalls(runId, latest, decisions, otherwise);
    let checkpointVersion = run.checkpointVersion;
    if (decided) {
      checkpointVersion += 1;
      await recordDecisions(transaction, decided, checkpointVersion);
    }
    const requeued = await transitionTurn(transaction.turns, {
      expected: { checkpointVersion, status: "needs-recovery" },
      runId,
      update: { lease: null, status: "queued" },
    });
    if (!requeued.ok) {
      throw new RecoveryResolutionError(runId, "conflict");
    }
  });
}

/** The latest checkpoint with decisions applied; `undefined` if none. */
function decideToolCalls(
  runId: string,
  latest: Checkpoint | null,
  decisions: ReadonlyMap<string, ToolRecoveryDecision>,
  fallback: ToolRecoveryDecision | undefined
): Checkpoint | undefined {
  const journal = toolStepJournal(latest);
  if (journal && journal.unreadable > 0) {
    // Recovery fails closed on an unreadable journal; no decision helps.
    throw new RecoveryResolutionError(runId, "unsupported");
  }
  const pending = pendingToolCalls(latest);
  const unknown = [...decisions.keys()].filter(
    (toolCallId) => !pending.some((call) => call.toolCallId === toolCallId)
  );
  if (unknown.length > 0) {
    throw new RecoveryResolutionError(runId, "unknown-tool-call", unknown);
  }
  const decisionFor = (
    call: PendingToolCall
  ): ToolRecoveryDecision | undefined =>
    decisions.get(call.toolCallId) ??
    (awaitsRecoveryDecision(call) ? fallback : undefined);
  const undecided = pending.filter(
    (call) => awaitsRecoveryDecision(call) && !decisionFor(call)
  );
  if (undecided.length > 0) {
    throw new RecoveryResolutionError(
      runId,
      "undecided",
      undecided.map((call) => call.toolCallId)
    );
  }
  if (!(latest && pending.some((call) => decisionFor(call)))) {
    return;
  }
  if (!journal) {
    // Older checkpoint formats cannot carry decisions.
    throw new RecoveryResolutionError(runId, "unsupported");
  }
  return {
    ...latest,
    runtimeState: {
      ...(latest.runtimeState as Record<string, unknown>),
      inflight: journal.inflight.map((call) => {
        const resolution = decisionFor(call);
        return resolution ? { ...call, resolution } : call;
      }),
    },
  };
}

async function recordDecisions(
  transaction: HostStoreTransaction,
  decided: Checkpoint,
  version: number
): Promise<void> {
  const written = await transaction.checkpoints.append(
    {
      ...decided,
      checkpointId: createCheckpointId({
        phase: decided.phase,
        runId: decided.runId,
        version,
      }),
      version,
    },
    { expectedVersion: version - 1 }
  );
  if (!written.ok) {
    throw new RecoveryResolutionError(decided.runId, "conflict");
  }
}

/** A copy of `decision` as stored: a result's output becomes plain JSON. */
function storedDecision(decision: ToolRecoveryDecision): ToolRecoveryDecision {
  switch (decision.action) {
    case "interrupt":
    case "rerun":
      return { action: decision.action };
    case "result":
      return { action: "result", output: jsonCopy(decision.output) };
    default:
      return assertNever(decision, "Unknown tool recovery decision.");
  }
}

function jsonCopy(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value ?? null);
  } catch (cause) {
    throw new TypeError("A recovery result output must be JSON.", { cause });
  }
  if (text === undefined) {
    throw new TypeError("A recovery result output must be JSON.");
  }
  return JSON.parse(text);
}
