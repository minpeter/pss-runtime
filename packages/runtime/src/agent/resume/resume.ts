import type {
  ExecutionHost,
  NotificationRecord,
  TurnRecord,
} from "../../execution/host/types";
import type { QueuedExecutionRun } from "../../thread/input/runtime-input";
import type { AgentTurn } from "../../thread/protocol/turn";
import { ownsAgentNamespace } from "../identity/namespace";

interface ResumeAgentTurnInput {
  readonly host: ExecutionHost;
  readonly ownerNamespace: string;
  resumeNotification(
    notification: NotificationRecord,
    executionRun: QueuedExecutionRun
  ): Promise<AgentTurn>;
  readonly runId: string;
}

export async function resumeAgentTurn({
  host,
  ownerNamespace,
  resumeNotification,
  runId,
}: ResumeAgentTurnInput): Promise<AgentTurn | null> {
  const run = await host.store.turns.get(runId);
  if (!run) {
    return null;
  }
  if (!canAccessRun(run, ownerNamespace)) {
    return null;
  }

  if (run.kind === "notification" && run.dedupeKey) {
    const idempotencyKey = run.dedupeKey;
    const claimed = await claimRun(host, run);
    if (!claimed) {
      return null;
    }

    const notification = await claimNotificationForRun({
      host,
      idempotencyKey,
      ownerNamespace,
    });
    if (!notification) {
      return null;
    }

    try {
      const notificationRun = await resumeNotification(notification, {
        kind: "notification",
        runId: claimed.runId,
      });
      if (notificationRun.runId !== claimed.runId) {
        await completeNotificationRun(host, claimed.runId);
      }
      return notificationRun;
    } catch (error) {
      await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
      throw error;
    }
  }

  return null;
}

async function claimNotificationForRun({
  host,
  idempotencyKey,
  ownerNamespace,
}: {
  readonly host: ExecutionHost;
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
}): Promise<NotificationRecord | null> {
  const current =
    await host.store.notifications.getByIdempotencyKey(idempotencyKey);
  if (!ownsAgentNamespace(current?.ownerNamespace, ownerNamespace)) {
    return null;
  }

  const claim =
    await host.store.notifications.claimByIdempotencyKey(idempotencyKey);
  if (claim.ok) {
    if (ownsAgentNamespace(claim.record.ownerNamespace, ownerNamespace)) {
      return claim.record;
    }
    await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
    return null;
  }

  if (
    claim.reason === "already-claimed" &&
    ownsAgentNamespace(claim.record?.ownerNamespace, ownerNamespace)
  ) {
    return claim.record ?? null;
  }

  return null;
}

function canAccessRun(run: TurnRecord, ownerNamespace: string): boolean {
  if (run.ownerNamespace) {
    return ownsAgentNamespace(run.ownerNamespace, ownerNamespace);
  }

  return (
    run.threadKey.startsWith(`parent:${ownerNamespace}:`) ||
    run.parentRunId?.startsWith(`${ownerNamespace}:session:`) === true
  );
}

export async function completeNotificationRun(
  host: ExecutionHost,
  runId: string
): Promise<void> {
  const run = await host.store.turns.get(runId);
  if (run?.kind !== "notification" || run.status === "completed") {
    return;
  }

  await host.store.turns.update({ ...run, status: "completed" });
}

async function claimRun(
  host: ExecutionHost,
  run: TurnRecord
): Promise<TurnRecord | null> {
  const claim = await host.store.turns.claim(run.runId, {
    attempt: (run.lease?.attempt ?? 0) + 1,
    leaseId: crypto.randomUUID(),
    leaseMs: 300_000,
    nowMs: Date.now(),
  });
  return claim.ok ? claim.record : null;
}
