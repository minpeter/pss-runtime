import type { JSONValue, ModelMessage } from "ai";
import { transitionTurn } from "../../execution/host/turn-status";
import type {
  AgentHost,
  Checkpoint,
  TurnRecord,
} from "../../execution/host/types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import type {
  RuntimeToolExecutionCheckpointMetadata,
  RuntimeToolRetryPolicy,
} from "../../llm/tool-execution-types";
import type { ThreadState } from "../state/thread-state";
import type { QueuedThreadExecutionRun } from "./execution";

export const DEFAULT_MAX_TURN_CLAIM_ATTEMPTS = 5;

export interface RecoveredDurableContinuation {
  readonly continuation: NonNullable<
    ReturnType<ThreadState["continuationCheckpoint"]>
  >;
  readonly executionRun: QueuedThreadExecutionRun;
}

export async function recoverPersistedThreadContinuation({
  executionHost,
  maxAttempts = DEFAULT_MAX_TURN_CLAIM_ATTEMPTS,
  signal,
  state,
  threadKey,
}: {
  readonly executionHost?: AgentHost;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<RecoveredDurableContinuation | undefined> {
  const turns = executionHost?.store.turns;
  if (!(executionHost && turns?.listByThreadKey)) {
    return;
  }

  const runs = await turns.listByThreadKey(threadKey);
  signal?.throwIfAborted();
  const latestRun = runs
    .filter((run) => run.kind === "user-turn" || run.kind === "tool-recovery")
    .at(-1);
  if (
    !latestRun ||
    latestRun.status === "completed" ||
    latestRun.status === "cancelled" ||
    latestRun.status === "error"
  ) {
    return;
  }

  const latestCheckpoint = await executionHost.store.checkpoints.latest(
    latestRun.runId
  );
  signal?.throwIfAborted();
  const unrecoverableTool = manualRecoveryToolCheckpoint(latestCheckpoint);
  if (latestRun.status === "needs-recovery" || unrecoverableTool) {
    if (latestRun.status !== "needs-recovery") {
      await transitionTurn(turns, {
        expected: {
          leaseId: latestRun.lease?.leaseId ?? null,
          status: latestRun.status,
        },
        runId: latestRun.runId,
        update: { lease: null, status: "needs-recovery" },
      });
    }
    if (unrecoverableTool) {
      throw new ToolExecutionNeedsRecoveryError(unrecoverableTool);
    }
    throw new Error(
      `Thread execution run ${latestRun.runId} requires manual recovery before continuing.`
    );
  }

  const claimed = await turns.claim(latestRun.runId, {
    attempt: (latestRun.lease?.attempt ?? 0) + 1,
    leaseId: crypto.randomUUID(),
    leaseMs: 300_000,
    maxAttempts,
    nowMs: Date.now(),
  });
  signal?.throwIfAborted();
  if (!claimed.ok) {
    if (claimed.reason === "leased") {
      throw Object.assign(new Error("Thread has active or queued work."), {
        code: "THREAD_CONTINUATION_BUSY",
      });
    }
    const current = await turns.get(latestRun.runId);
    if (current?.status === "needs-recovery") {
      throw new Error(
        `Thread execution run ${latestRun.runId} requires recovery after exceeding maxAttempts.`
      );
    }
    return;
  }

  await state.refresh();
  signal?.throwIfAborted();
  const history = buildRecoveredContinuationHistory(
    state.modelSnapshot(),
    latestCheckpoint
  );
  if (history.length === 0) {
    await transitionTurn(turns, {
      expected: {
        leaseId: claimed.lease.leaseId,
        status: claimed.record.status,
      },
      runId: claimed.record.runId,
      update: { lease: null, status: "cancelled" },
    });
    return;
  }

  state.setContinuationCheckpoint(history);
  const continuation = state.continuationCheckpoint();
  if (!continuation) {
    return;
  }
  return {
    continuation,
    executionRun: {
      kind: claimed.record.kind,
      leaseId: claimed.lease.leaseId,
      runId: claimed.record.runId,
    },
  };
}

export function buildRecoveredContinuationHistory(
  baseHistory: readonly ModelMessage[],
  checkpoint: Checkpoint | null
): ModelMessage[] {
  const unrecoverableTool = manualRecoveryToolCheckpoint(checkpoint);
  if (unrecoverableTool) {
    throw new ToolExecutionNeedsRecoveryError(unrecoverableTool);
  }
  const history = structuredClone([...baseHistory]);
  if (checkpoint?.phase !== "after-tool") {
    return history;
  }

  const afterTool = afterToolRuntimeState(checkpoint.runtimeState);
  if (!afterTool || hasToolResultInHistory(history, afterTool.toolCallId)) {
    return history;
  }

  history.push(
    {
      content: [
        {
          input: afterTool.input,
          toolCallId: afterTool.toolCallId,
          toolName: afterTool.toolName,
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output:
            typeof afterTool.output === "string"
              ? { type: "text", value: afterTool.output }
              : {
                  type: "json",
                  value:
                    afterTool.output === undefined
                      ? null
                      : (afterTool.output as JSONValue),
                },
          toolCallId: afterTool.toolCallId,
          toolName: afterTool.toolName,
          type: "tool-result",
        },
      ],
      role: "tool",
    }
  );
  return history;
}

export function manualRecoveryToolCheckpoint(
  checkpoint: Checkpoint | null
): RuntimeToolExecutionCheckpointMetadata | undefined {
  if (checkpoint?.phase !== "before-tool") {
    return;
  }
  const metadata = parseToolCheckpointMetadata(checkpoint.pendingToolCall);
  if (metadata?.policy === "manual-recovery") {
    return metadata;
  }
  return;
}

function parseToolCheckpointMetadata(
  value: unknown
): RuntimeToolExecutionCheckpointMetadata | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.attempt !== "number" ||
    typeof candidate.idempotencyKey !== "string" ||
    !isRetryPolicy(candidate.policy) ||
    typeof candidate.toolCallId !== "string" ||
    typeof candidate.toolName !== "string"
  ) {
    return;
  }
  return {
    attempt: candidate.attempt,
    idempotencyKey: candidate.idempotencyKey,
    policy: candidate.policy,
    toolCallId: candidate.toolCallId,
    toolName: candidate.toolName,
  };
}

function isRetryPolicy(value: unknown): value is RuntimeToolRetryPolicy {
  return (
    value === "idempotent" || value === "manual-recovery" || value === "pure"
  );
}

function afterToolRuntimeState(value: unknown):
  | {
      readonly input: unknown;
      readonly output: unknown;
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.toolCallId !== "string" ||
    typeof candidate.toolName !== "string" ||
    !("output" in candidate)
  ) {
    return;
  }
  return {
    input: candidate.input ?? {},
    output: candidate.output,
    toolCallId: candidate.toolCallId,
    toolName: candidate.toolName,
  };
}

function hasToolResultInHistory(
  history: readonly ModelMessage[],
  toolCallId: string
): boolean {
  return history.some(
    (message) =>
      message.role === "tool" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "toolCallId" in part &&
          part.toolCallId === toolCallId
      )
  );
}

export function isRecordClaimableByAgent(
  run: TurnRecord,
  ownerNamespace: string,
  hasExplicitNamespace: boolean,
  ownsNamespace: (candidate: string | undefined, owner: string) => boolean
): boolean {
  if (run.kind === "notification") {
    return ownsNamespace(run.ownerNamespace, ownerNamespace);
  }
  if (run.ownerNamespace !== undefined) {
    return ownsNamespace(run.ownerNamespace, ownerNamespace);
  }
  return !hasExplicitNamespace;
}
