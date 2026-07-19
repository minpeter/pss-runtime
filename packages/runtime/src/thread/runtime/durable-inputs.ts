import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type {
  AdmitReceipt,
  AgentHost,
  ClaimedThreadInput,
  RecoverThreadInputClaimsResult,
  ThreadInputBoundary,
  ThreadInputKind,
  ThreadInputPlacement,
  ThreadInputRecord,
  TurnRecord,
} from "../../execution/host/types";
import { ThreadInputInboxUnavailableError } from "../../execution/host/unsupported-thread-input-inbox";
import type { UserInput } from "../input/input";
import type { QueuedInput } from "../input/runtime-input";
import type { ThreadState } from "../state/thread-state";
import { precreateThreadExecutionRun } from "./execution";
import {
  appendDurableThreadEvents,
  type DurableThreadEventBuffer,
  restoreDurableThreadEvents,
  takeDurableThreadEvents,
  transactionalThreadEvents,
} from "./thread-event-log";

export type DurableInputAdmission =
  | {
      readonly executionRun?: TurnRecord;
      readonly kind: "admitted";
      readonly receipt: AdmitReceipt;
    }
  | { readonly kind: "unavailable" };

export type DurableInputClaim =
  | {
      readonly kind: "claimed";
      readonly record: ClaimedThreadInput | null;
    }
  | { readonly kind: "unavailable" };

export async function admitDurableThreadInput({
  executionHost,
  input,
  kind,
  placement,
  precreateExecutionRun = false,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly input: UserInput;
  readonly kind: ThreadInputKind;
  readonly placement?: ThreadInputPlacement;
  readonly precreateExecutionRun?: boolean;
  readonly threadKey: string;
}): Promise<DurableInputAdmission> {
  if (!executionHost) {
    return { kind: "unavailable" };
  }

  try {
    const messageId = crypto.randomUUID();
    if (precreateExecutionRun) {
      return await executionHost.store.transaction(async (transaction) => {
        const receipt = await transaction.inputs.admit({
          input,
          kind,
          messageId,
          placement,
          threadKey,
        });
        if (receipt.duplicate) {
          return { kind: "admitted", receipt };
        }
        const executionRun = await precreateThreadExecutionRun({
          kind: "user-turn",
          runId: createThreadExecutionRunId({ threadKey, turnId: messageId }),
          threadKey,
          turnStore: transaction.turns,
        });
        return { executionRun, kind: "admitted", receipt };
      });
    }

    const receipt = await executionHost.store.inputs.admit({
      input,
      kind,
      messageId,
      placement,
      threadKey,
    });
    return { kind: "admitted", receipt };
  } catch (error) {
    if (isThreadInputInboxUnavailable(error)) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

export async function claimDurableThreadInput({
  boundary,
  executionHost,
  messageId,
  threadKey,
}: {
  readonly boundary: ThreadInputBoundary;
  readonly executionHost: AgentHost | undefined;
  readonly messageId?: string;
  readonly threadKey: string;
}): Promise<DurableInputClaim> {
  if (!executionHost) {
    return { kind: "unavailable" };
  }

  try {
    const record = await executionHost.store.inputs.claimNext(
      threadKey,
      boundary,
      messageId ? { messageId } : undefined
    );
    return { kind: "claimed", record };
  } catch (error) {
    if (isThreadInputInboxUnavailable(error)) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

export async function promoteAndAckDurableThreadInput({
  executionHost,
  record,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly record: ClaimedThreadInput;
}): Promise<ThreadInputRecord | null> {
  if (!executionHost) {
    return null;
  }

  const promoted = await executionHost.store.inputs.markPromoted(record);
  if (!promoted) {
    return null;
  }
  return await executionHost.store.inputs.ack(promoted);
}

export async function commitAndAckDurableThreadInput({
  buffer,
  executionHost,
  record,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost: AgentHost | undefined;
  readonly record: ClaimedThreadInput;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = takeDurableThreadEvents(buffer);
  if (!executionHost) {
    try {
      await state.commit();
    } catch (error) {
      restoreDurableThreadEvents(buffer, pendingEvents);
      throw error;
    }
    return;
  }

  const eventLogEnabled = executionHost.store.threadEvents !== undefined;
  try {
    await state.commitWith(
      async (commit) =>
        await executionHost.store.transaction(async (tx) => {
          const result = await tx.threads.commit(commit.key, commit.next, {
            expectedVersion: commit.expectedVersion,
          });
          if (!result.ok) {
            return result;
          }

          const promoted = await tx.inputs.markPromoted(record);
          if (!promoted) {
            throw new DurableThreadInputClaimError("promote", record);
          }

          const acked = await tx.inputs.ack(promoted);
          if (!acked) {
            throw new DurableThreadInputClaimError("ack", record);
          }

          if (eventLogEnabled && pendingEvents.length > 0) {
            await appendDurableThreadEvents(
              transactionalThreadEvents(tx),
              threadKey,
              pendingEvents
            );
          }

          return result;
        })
    );
  } catch (error) {
    restoreDurableThreadEvents(buffer, pendingEvents);
    throw error;
  }
}

export async function ackDurableThreadInput({
  executionHost,
  record,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly record: ClaimedThreadInput;
}): Promise<void> {
  if (!executionHost) {
    return;
  }

  await executionHost.store.transaction(async (tx) => {
    const promoted = await tx.inputs.markPromoted(record);
    if (!promoted) {
      throw new DurableThreadInputClaimError("promote", record);
    }

    const acked = await tx.inputs.ack(promoted);
    if (!acked) {
      throw new DurableThreadInputClaimError("ack", record);
    }
  });
}

export async function recoverDurableThreadInputs({
  executionHost,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly threadKey: string;
}): Promise<RecoverThreadInputClaimsResult> {
  if (!executionHost) {
    return emptyRecoveredThreadInputClaims();
  }

  try {
    return await executionHost.store.inputs.recoverClaims(threadKey);
  } catch (error) {
    if (isThreadInputInboxUnavailable(error)) {
      return emptyRecoveredThreadInputClaims();
    }
    throw error;
  }
}

export async function releaseDurableThreadInputClaim({
  executionHost,
  record,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly record: ClaimedThreadInput;
}): Promise<void> {
  if (!executionHost) {
    return;
  }

  await executionHost.store.inputs.releaseClaim(record);
}

export async function cancelQueuedDurableThreadInputs({
  executionHost,
  items,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly items: readonly QueuedInput[];
  readonly threadKey: string;
}): Promise<void> {
  const durableItems = items.filter(
    (item): item is QueuedInput & { readonly durableMessageId: string } =>
      typeof item.durableMessageId === "string"
  );
  if (!(executionHost && durableItems.length > 0)) {
    return;
  }

  await executionHost.store.transaction(async (transaction) => {
    for (const item of durableItems) {
      const claimed = await transaction.inputs.claimNext(
        threadKey,
        "turn-idle",
        { messageId: item.durableMessageId }
      );
      if (!claimed) {
        continue;
      }
      const promoted = await transaction.inputs.markPromoted(claimed);
      if (!promoted) {
        throw new DurableThreadInputClaimError("promote", claimed);
      }
      const acked = await transaction.inputs.ack(promoted);
      if (!acked) {
        throw new DurableThreadInputClaimError("ack", claimed);
      }

      const runId = item.executionRun?.runId ?? item.run.runId;
      if (!runId) {
        continue;
      }
      const run = await transaction.turns.get(runId);
      if (run && !isTerminalTurnStatus(run.status)) {
        await transaction.turns.update({ ...run, status: "cancelled" });
      }
    }
  });
}

function isTerminalTurnStatus(status: TurnRecord["status"]): boolean {
  return (
    status === "cancelled" ||
    status === "completed" ||
    status === "error" ||
    status === "needs-recovery"
  );
}

function isThreadInputInboxUnavailable(
  error: unknown
): error is ThreadInputInboxUnavailableError {
  return error instanceof ThreadInputInboxUnavailableError;
}

function emptyRecoveredThreadInputClaims(): RecoverThreadInputClaimsResult {
  return { acked: [], released: [] };
}

class DurableThreadInputClaimError extends Error {
  constructor(operation: "ack" | "promote", record: ClaimedThreadInput) {
    super(
      `Unable to ${operation} durable thread input ${record.messageId} for ${record.threadKey}.`
    );
    this.name = "DurableThreadInputClaimError";
  }
}
