import {
  abandonedLeaseId,
  processLeaseOwner,
  TURN_LEASE_MS,
} from "../../execution/host/lease-owner";
import { transitionTurn } from "../../execution/host/turn-status";
import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";
import type {
  AgentHost,
  Checkpoint,
  LeaseOwnerLiveness,
  NotificationInbox,
  NotificationRecord,
  TurnLease,
  TurnRecord,
  TurnStore,
} from "../../execution/host/types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import {
  DEFAULT_MAX_TURN_CLAIM_ATTEMPTS,
  isRecordClaimableByAgent,
  releaseClaimedContinuationRun,
  SupersededExecutionRunError,
  throwIfManualToolRecovery,
  verifyClaimedRunCheckpoint,
} from "../../thread/handle/agent-thread-continuation";
import { isThreadDrainOwned } from "../../thread/handle/thread-drain-coordinator";
import type { AgentTurn } from "../../thread/protocol/turn";
import { ownsAgentNamespace } from "../identity/namespace";
import { leaseIdForResumeClaim } from "./retry-authority";

export type ClaimedTurnRecord = TurnRecord & {
  readonly lease: TurnLease;
};

interface ResumeAgentTurnInput {
  readonly claim?: object;
  readonly hasExplicitNamespace?: boolean;
  readonly host: AgentHost;
  readonly maxAttempts?: number;
  readonly ownerNamespace: string;
  resumeExecutionTurn?(
    run: ClaimedTurnRecord,
    checkpoint: Checkpoint | null
  ): Promise<AgentTurn>;
  resumeNotification(
    notification: NotificationRecord,
    run: ClaimedTurnRecord
  ): Promise<AgentTurn>;
  readonly runId: string;
}

export async function resumeAgentTurn({
  claim,
  hasExplicitNamespace = false,
  host,
  maxAttempts = DEFAULT_MAX_TURN_CLAIM_ATTEMPTS,
  ownerNamespace,
  resumeExecutionTurn,
  resumeNotification,
  runId,
}: ResumeAgentTurnInput): Promise<AgentTurn | null> {
  const retryLeaseId = leaseIdForResumeClaim(claim, runId);
  const run = await host.store.turns.get(runId);
  if (!run) {
    return null;
  }
  if (!isRecordClaimableByAgent(run, ownerNamespace, hasExplicitNamespace)) {
    return null;
  }
  if (run.kind === "notification" && run.dedupeKey) {
    const idempotencyKey = run.dedupeKey;
    const claimedTuple = await host.store.transaction(async (transaction) => {
      const claimed = await claimRun(
        transaction.turns,
        run,
        retryLeaseId,
        maxAttempts,
        host.ownerLiveness
      );
      if (!claimed) {
        return null;
      }

      const notificationClaim = await claimNotificationForRun(
        transaction.notifications,
        idempotencyKey
      );
      if (!notificationClaim) {
        await requeueClaimedRun(transaction.turns, claimed);
        return null;
      }
      const notification = notificationClaim.record;
      if (
        claimed.kind !== "notification" ||
        claimed.dedupeKey === undefined ||
        notification.idempotencyKey !== claimed.dedupeKey ||
        notification.runId !== claimed.runId ||
        notification.threadKey !== claimed.threadKey ||
        notification.ownerNamespace !== claimed.ownerNamespace ||
        !ownsAgentNamespace(claimed.ownerNamespace, ownerNamespace) ||
        notification.notificationId.length === 0
      ) {
        if (notificationClaim.release) {
          await transaction.notifications.releaseByIdempotencyKey(
            idempotencyKey
          );
        }
        await requeueClaimedRun(transaction.turns, claimed);
        return null;
      }

      return { notification: notificationClaim.record, run: claimed };
    });
    if (!claimedTuple) {
      return null;
    }
    const { notification, run: claimed } = claimedTuple;

    try {
      const notificationRun = await resumeNotification(notification, claimed);
      if (notificationRun.runId !== claimed.runId) {
        await completeNotificationRun(
          host,
          claimed.runId,
          claimed.lease.leaseId
        );
      }
      return notificationRun;
    } catch (error) {
      await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
      throw error;
    }
  }
  if (
    (run.kind === "user-turn" || run.kind === "tool-recovery") &&
    resumeExecutionTurn
  ) {
    return await resumeClaimedExecutionTurn({
      host,
      maxAttempts,
      resumeExecutionTurn,
      retryLeaseId,
      run,
    });
  }

  return null;
}

async function resumeClaimedExecutionTurn({
  host,
  maxAttempts,
  resumeExecutionTurn,
  retryLeaseId,
  run,
}: {
  readonly host: AgentHost;
  readonly maxAttempts: number;
  readonly resumeExecutionTurn: NonNullable<
    ResumeAgentTurnInput["resumeExecutionTurn"]
  >;
  readonly retryLeaseId: string | undefined;
  readonly run: TurnRecord;
}): Promise<AgentTurn | null> {
  if (run.status === "needs-recovery") {
    await throwIfManualToolRecovery(host, run.runId);
    return null;
  }
  if (isThreadDrainOwned(host, run.threadKey)) {
    return null;
  }
  const claimed = await host.store.transaction(
    async (transaction) =>
      await claimRun(
        transaction.turns,
        run,
        retryLeaseId,
        maxAttempts,
        host.ownerLiveness
      )
  );
  if (!claimed) {
    if ((await host.store.turns.get(run.runId))?.status === "needs-recovery") {
      await throwIfManualToolRecovery(host, run.runId);
    }
    return null;
  }
  try {
    const checkpoint = await verifyClaimedRunCheckpoint(
      host,
      claimed,
      claimed.lease.leaseId
    );
    return await resumeExecutionTurn(claimed, checkpoint);
  } catch (error) {
    if (error instanceof SupersededExecutionRunError) {
      return null;
    }
    // A pending-input handoff may already have released the claim to queued;
    // the fenced requeue then conflicts harmlessly.
    if (!(error instanceof ToolExecutionNeedsRecoveryError)) {
      await requeueClaimedRun(host.store.turns, claimed).catch(() => undefined);
    }
    throw error;
  }
}

interface ClaimedNotification {
  readonly record: NotificationRecord;
  readonly release: boolean;
}

async function claimNotificationForRun(
  notifications: NotificationInbox,
  idempotencyKey: string
): Promise<ClaimedNotification | null> {
  const claim = await notifications.claimByIdempotencyKey(idempotencyKey);
  if (claim.ok) {
    return { record: claim.record, release: true };
  }
  if (claim.reason === "already-claimed" && claim.record) {
    return { record: claim.record, release: false };
  }
  return null;
}

function requeueClaimedRun(turns: TurnStore, run: TurnRecord): Promise<void> {
  return releaseClaimedContinuationRun(turns, run, run.lease?.leaseId ?? null);
}

export async function completeNotificationRun(
  host: AgentHost,
  runId: string,
  leaseId: string | null
): Promise<void> {
  const run = await host.store.turns.get(runId);
  if (
    run?.kind !== "notification" ||
    run.status === "cancelled" ||
    run.status === "completed" ||
    run.status === "error" ||
    run.status === "needs-recovery"
  ) {
    return;
  }

  const transition = await transitionTurn(host.store.turns, {
    expected: { leaseId, status: run.status },
    runId,
    update: { status: "completed" },
  });
  if (!transition.ok) {
    throw new TurnTransitionConflictError(
      runId,
      "notification",
      transition.reason
    );
  }
}

async function claimRun(
  turns: TurnStore,
  run: TurnRecord,
  retryLeaseId: string | undefined,
  maxAttempts: number,
  liveness: LeaseOwnerLiveness | undefined
): Promise<ClaimedTurnRecord | null> {
  const result = await turns.claim(run.runId, {
    abandonedLeaseId: abandonedLeaseId(run, liveness),
    attempt: (run.lease?.attempt ?? 0) + 1,
    leaseId: retryLeaseId ?? crypto.randomUUID(),
    leaseMs: TURN_LEASE_MS,
    maxAttempts,
    nowMs: Date.now(),
    owner: processLeaseOwner(liveness),
  });
  return result.ok ? { ...result.record, lease: result.lease } : null;
}
