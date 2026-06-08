import type { ExecutionHost } from "./execution/types";
import type { AgentEvent } from "./session/events";
import type { UserInput } from "./session/input";
import type { SubagentJob } from "./subagent-types";

type InlineNotificationMode = "inline" | "queued-only";

interface NotificationResumePayload {
  readonly idempotencyKey: string;
  readonly notificationId: string;
  readonly runId: string;
}

export async function enqueueDurableBackgroundNotification({
  input,
  jobs,
  observerEvents,
}: {
  readonly input: UserInput;
  readonly jobs: readonly SubagentJob[];
  readonly observerEvents: readonly AgentEvent[];
}): Promise<InlineNotificationMode> {
  const host = findExecutionHost(jobs);
  const parentSessionKey = findParentSessionKey(jobs);
  const ownerNamespace = findOwnerNamespace(jobs);
  if (!host) {
    return "inline";
  }

  if (await hasCancelledChildRun({ host, jobs })) {
    return "queued-only";
  }

  if (!(parentSessionKey && ownerNamespace)) {
    return "inline";
  }

  if (host.capabilities.backgroundSubagents !== "durable") {
    return "inline";
  }

  const idempotencyKey = backgroundNotificationIdempotencyKey({
    jobs,
    parentSessionKey,
  });
  const existing =
    await host.store.notifications.getByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (
      existing.status === "pending" &&
      host.capabilities.backgroundSubagents === "durable"
    ) {
      await host.scheduler.resumeSession(
        existing.sessionKey,
        resumePayloadFromNotification(existing)
      );
    }
    return "queued-only";
  }

  const created = await createNotificationRecord({
    host,
    idempotencyKey,
    input,
    jobs,
    observerEvents,
    ownerNamespace,
    parentSessionKey,
  });
  if (created) {
    await host.scheduler.resumeSession(parentSessionKey, created);
  }

  return "queued-only";
}

async function hasCancelledChildRun({
  host,
  jobs,
}: {
  readonly host: ExecutionHost;
  readonly jobs: readonly SubagentJob[];
}): Promise<boolean> {
  for (const job of jobs) {
    if (!job.childRunId) {
      continue;
    }

    const run = await host.store.runs.get(job.childRunId);
    if (run?.status === "cancelled") {
      return true;
    }
  }

  return false;
}

function findExecutionHost(
  jobs: readonly SubagentJob[]
): ExecutionHost | undefined {
  return jobs.find((job) => job.executionHost)?.executionHost;
}

function findParentSessionKey(
  jobs: readonly SubagentJob[]
): string | undefined {
  return jobs.find((job) => job.parentSessionKey)?.parentSessionKey;
}

function findOwnerNamespace(jobs: readonly SubagentJob[]): string | undefined {
  return jobs.find((job) => job.ownerNamespace)?.ownerNamespace;
}

function backgroundNotificationIdempotencyKey({
  jobs,
  parentSessionKey,
}: {
  readonly jobs: readonly SubagentJob[];
  readonly parentSessionKey: string;
}): string {
  const taskIds = jobs
    .map((job) => job.id)
    .sort()
    .join(",");
  return `background-complete:${parentSessionKey}:${taskIds}`;
}

async function createNotificationRecord({
  host,
  idempotencyKey,
  input,
  jobs,
  observerEvents,
  ownerNamespace,
  parentSessionKey,
}: {
  readonly host: ExecutionHost;
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly jobs: readonly SubagentJob[];
  readonly observerEvents: readonly AgentEvent[];
  readonly ownerNamespace: string;
  readonly parentSessionKey: string;
}): Promise<NotificationResumePayload | undefined> {
  const notificationId = `ntf_${crypto.randomUUID().replaceAll("-", "")}`;
  const runId = `notification:${notificationId}`;
  return await host.store.transaction(async (tx) => {
    const duplicate =
      await tx.notifications.getByIdempotencyKey(idempotencyKey);
    if (duplicate) {
      return;
    }

    const enqueued = await tx.notifications.enqueue({
      idempotencyKey,
      input,
      notificationId,
      observerEvents,
      ownerNamespace,
      runId,
      sessionKey: parentSessionKey,
      status: "pending",
    });
    if (!enqueued.ok) {
      return;
    }

    await tx.runs.create({
      checkpointVersion: 0,
      dedupeKey: idempotencyKey,
      kind: "notification",
      ownerNamespace,
      parentRunId: jobs.length === 1 ? jobs[0]?.childRunId : undefined,
      rootRunId: runId,
      runId,
      sessionKey: parentSessionKey,
      status: "queued",
    });
    const checkpoint = await tx.checkpoints.append(
      {
        checkpointId: crypto.randomUUID(),
        phase: "before-notification",
        runId,
        runtimeState: {},
        sessionSnapshot: {},
        version: 1,
      },
      { expectedVersion: 0 }
    );
    if (!checkpoint.ok) {
      throw new Error("Failed to write background notification checkpoint.");
    }
    return { idempotencyKey, notificationId, runId };
  });
}

function resumePayloadFromNotification(
  notification: NotificationResumePayload
): NotificationResumePayload {
  return {
    idempotencyKey: notification.idempotencyKey,
    notificationId: notification.notificationId,
    runId: notification.runId,
  };
}
