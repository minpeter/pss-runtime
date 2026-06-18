import { agentNamespace } from "../../agent/identity/namespace";
import type { AgentEvent, UserInput } from "../../session/protocol/events";
import type {
  ExecutionHost,
  NotificationRecord,
  RunRecord,
} from "../host/types";

export interface DispatchAgentNotificationInput {
  readonly host: ExecutionHost;
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly namespace: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly sessionKey: string;
}

export interface DispatchedAgentNotification {
  readonly deduplicated: boolean;
  readonly idempotencyKey: string;
  readonly notificationId: string;
  readonly runId: string;
}

interface SchedulableAgentNotification extends DispatchedAgentNotification {
  readonly sessionKey: string;
  readonly storageIdempotencyKey: string;
}

class DuplicateNotificationError extends Error {
  constructor() {
    super("duplicate_notification");
    this.name = "DuplicateNotificationError";
  }
}

export async function dispatchAgentNotification(
  input: DispatchAgentNotificationInput
): Promise<DispatchedAgentNotification> {
  const ownerNamespace = agentNamespace(input.namespace);
  const storageIdempotencyKey = scopedNotificationIdempotencyKey({
    idempotencyKey: input.idempotencyKey,
    ownerNamespace,
    sessionKey: input.sessionKey,
  });
  const existing = await queuedNotificationRun({
    host: input.host,
    idempotencyKey: input.idempotencyKey,
    ownerNamespace,
    sessionKey: input.sessionKey,
    storageIdempotencyKey,
  });
  if (existing) {
    await scheduleAgentNotification(input.host, existing);
    return dispatchedAgentNotification(existing);
  }

  const runId = crypto.randomUUID();
  const notificationId = crypto.randomUUID();
  const runRecord = {
    checkpointVersion: 0,
    dedupeKey: storageIdempotencyKey,
    kind: "notification",
    ownerNamespace,
    rootRunId: runId,
    runId,
    sessionKey: input.sessionKey,
    status: "queued",
  } satisfies RunRecord;
  const notificationRecord = {
    idempotencyKey: storageIdempotencyKey,
    input: input.input,
    notificationId,
    observerEvents: input.observerEvents,
    ownerNamespace,
    runId,
    sessionKey: input.sessionKey,
    status: "pending",
  } satisfies NotificationRecord;

  try {
    await input.host.store.transaction(async (tx) => {
      await tx.runs.create(runRecord);
      const writeResult = await tx.notifications.enqueue(notificationRecord);
      if (!writeResult.ok) {
        throw new DuplicateNotificationError();
      }
    });
  } catch (error) {
    if (error instanceof DuplicateNotificationError) {
      const deduplicated = await queuedNotificationRun({
        host: input.host,
        idempotencyKey: input.idempotencyKey,
        ownerNamespace,
        sessionKey: input.sessionKey,
        storageIdempotencyKey,
      });
      if (deduplicated) {
        await scheduleAgentNotification(input.host, deduplicated);
        return dispatchedAgentNotification(deduplicated);
      }
    }
    throw error;
  }

  const created = {
    deduplicated: false,
    idempotencyKey: input.idempotencyKey,
    notificationId,
    runId,
    sessionKey: input.sessionKey,
    storageIdempotencyKey,
  } satisfies SchedulableAgentNotification;
  await scheduleAgentNotification(input.host, created);
  return dispatchedAgentNotification(created);
}

async function queuedNotificationRun({
  host,
  idempotencyKey,
  ownerNamespace,
  sessionKey,
  storageIdempotencyKey,
}: {
  readonly host: ExecutionHost;
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
  readonly sessionKey: string;
  readonly storageIdempotencyKey: string;
}): Promise<SchedulableAgentNotification | null> {
  const existingRun = await host.store.runs.getByDedupeKey(
    storageIdempotencyKey
  );
  if (
    existingRun?.kind !== "notification" ||
    existingRun.ownerNamespace !== ownerNamespace ||
    existingRun.sessionKey !== sessionKey
  ) {
    return null;
  }

  const existingNotification =
    await host.store.notifications.getByIdempotencyKey(storageIdempotencyKey);
  return {
    deduplicated: true,
    idempotencyKey,
    notificationId: existingNotification?.notificationId ?? existingRun.runId,
    runId: existingRun.runId,
    sessionKey: existingRun.sessionKey,
    storageIdempotencyKey,
  };
}

function scheduleAgentNotification(
  host: ExecutionHost,
  notification: SchedulableAgentNotification
): Promise<void> {
  return host.scheduler.resumeSession(notification.sessionKey, {
    idempotencyKey: notification.storageIdempotencyKey,
    notificationId: notification.notificationId,
    runId: notification.runId,
  });
}

function dispatchedAgentNotification(
  notification: SchedulableAgentNotification
): DispatchedAgentNotification {
  return {
    deduplicated: notification.deduplicated,
    idempotencyKey: notification.idempotencyKey,
    notificationId: notification.notificationId,
    runId: notification.runId,
  };
}

function scopedNotificationIdempotencyKey({
  idempotencyKey,
  ownerNamespace,
  sessionKey,
}: {
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
  readonly sessionKey: string;
}): string {
  return [ownerNamespace, sessionKey, idempotencyKey]
    .map((part) => encodeURIComponent(part))
    .join(":");
}
