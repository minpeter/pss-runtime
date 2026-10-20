import {
  type TurnRecord,
  type TurnStatus,
  type TurnStore,
  transitionTurn,
} from "../../../../execution";
import {
  abandonedLeaseId,
  processLeaseOwner,
  TURN_LEASE_MS,
} from "../../../../execution/host/lease-owner";
import { durableObjectOwnerLiveness } from "../../host/activation-liveness";
import { createDurableObjectStorageHost as createCloudflareStorageHost } from "../../host/storage-host";
import {
  type DurableObjectStorage as CloudflareDurableObjectStorage,
  withSqlStorage,
} from "../../storage/durable-object/durable-object-storage";
import { withTransaction } from "../../storage/durable-object/sql-access";

interface ScheduledNotificationRetry {
  readonly allowNonNotification: boolean;
  readonly leaseId: string;
  readonly prefix: string;
  readonly runId: string;
  readonly schedule: (storage: CloudflareDurableObjectStorage) => Promise<void>;
  readonly storage: CloudflareDurableObjectStorage;
}

export async function prepareScheduledNotificationRetry({
  allowNonNotification,
  leaseId,
  prefix,
  runId,
  schedule,
  storage,
}: ScheduledNotificationRetry): Promise<boolean> {
  return await withTransaction(storage, async (txStorage) => {
    const transactionStorage = withSqlStorage(
      txStorage,
      txStorage.sql ?? storage.sql
    );
    const tx = createCloudflareStorageHost({
      prefix,
      storage: transactionStorage,
    }).store;
    const run = await captureRetryOwnership({
      allowNonNotification,
      leaseId,
      runId,
      turns: tx.turns,
    });
    if (!run) {
      return false;
    }

    const transition = await transitionTurn(tx.turns, {
      expected: {
        leaseId,
        status: run.status,
      },
      runId,
      update: { lease: null, status: "queued" },
    });
    if (!transition.ok) {
      return false;
    }
    const dedupeKey = run.kind === "notification" ? run.dedupeKey : undefined;
    try {
      await schedule(transactionStorage);
    } catch (error) {
      const rollback = await transitionTurn(tx.turns, {
        expected: { leaseId: null, status: "queued" },
        runId,
        update: {
          lease: run.lease ?? null,
          status: run.status,
        },
      });
      if (!rollback.ok) {
        throw new Error(
          `Retry schedule rollback failed for ${runId}: ${rollback.reason}.`,
          { cause: error }
        );
      }
      throw error;
    }
    if (dedupeKey) {
      await tx.notifications.releaseByIdempotencyKey(dedupeKey);
    }
    return true;
  });
}

async function captureRetryOwnership({
  allowNonNotification,
  leaseId,
  runId,
  turns,
}: {
  readonly allowNonNotification: boolean;
  readonly leaseId: string;
  readonly runId: string;
  readonly turns: TurnStore;
}): Promise<TurnRecord | null> {
  const run = await turns.get(runId);
  if (!isRetryableRun(run, allowNonNotification)) {
    return null;
  }
  if ((run.lease?.leaseId ?? null) === leaseId) {
    return run;
  }
  // An interrupted activation leaves its lease behind; adopt that one too.
  const abandoned = abandonedLeaseId(run, durableObjectOwnerLiveness);
  if (run.lease !== undefined && abandoned === undefined) {
    return null;
  }
  const claim = await turns.claim(runId, {
    abandonedLeaseId: abandoned,
    attempt: 1,
    leaseId,
    leaseMs: TURN_LEASE_MS,
    nowMs: Date.now(),
    owner: processLeaseOwner(durableObjectOwnerLiveness),
  });
  return claim.ok ? claim.record : null;
}

function isRetryableRun(
  run: TurnRecord | null,
  allowNonNotification: boolean
): run is TurnRecord {
  if (!(run && isRetryableRunStatus(run.status))) {
    return false;
  }
  return run.kind === "notification"
    ? run.dedupeKey !== undefined
    : allowNonNotification;
}

function isRetryableRunStatus(status: TurnStatus): boolean {
  return (
    status === "leased" ||
    status === "queued" ||
    status === "running" ||
    status === "suspended"
  );
}
