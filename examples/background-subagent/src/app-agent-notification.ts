import type { Agent, AgentInput, AgentTurn } from "@minpeter/pss-runtime";
import type {
  AgentHost,
  NotificationRecord,
  TurnRecord,
} from "@minpeter/pss-runtime/execution";
import type { readDurableBackgroundDelegationState } from "./background-delegation";

export async function enqueueCompletionNotification({
  host,
  run,
  state,
}: {
  readonly host: AgentHost;
  readonly run: TurnRecord;
  readonly state: NonNullable<
    ReturnType<typeof readDurableBackgroundDelegationState>
  >;
}): Promise<void> {
  const parentThreadKey = state.parentThreadKey ?? "default";
  const taskId = run.publicTaskId ?? run.runId;
  const idempotencyKey = `background-complete:${parentThreadKey}:${taskId}`;
  const notificationId = `notification:${taskId}`;
  const notificationRunId = `notification:${taskId}`;
  const notificationResult = await host.store.notifications.enqueue({
    idempotencyKey,
    input: {
      text: [
        `<system-reminder>Background task ${taskId} completed.`,
        "Use background_output with the task_id to inspect the stored result.</system-reminder>",
      ].join(" "),
      type: "user-input",
    },
    notificationId,
    ownerNamespace: run.ownerNamespace,
    runId: notificationRunId,
    threadKey: parentThreadKey,
    status: "pending",
  });
  if (!notificationResult.ok) {
    return;
  }

  await host.store.turns.create({
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    ownerNamespace: run.ownerNamespace,
    rootRunId: notificationRunId,
    runId: notificationRunId,
    threadKey: parentThreadKey,
    status: "queued",
  });
  await host.scheduler.resumeThread(parentThreadKey, {
    idempotencyKey,
    notificationId,
    runId: notificationRunId,
  });
}

export async function resumeCompletionNotification({
  coordinator,
  dedupeKey,
  host,
  ownerNamespace,
  parentThreadKey,
  run,
}: {
  readonly coordinator: Agent;
  readonly dedupeKey: string;
  readonly host: AgentHost;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly run: TurnRecord;
}): Promise<AgentTurn | null> {
  if (
    run.ownerNamespace !== ownerNamespace ||
    run.threadKey !== parentThreadKey
  ) {
    return null;
  }

  const notification = await claimOwnedNotification({
    host,
    idempotencyKey: dedupeKey,
    ownerNamespace,
    parentThreadKey,
  });
  if (!notification) {
    return null;
  }

  const notificationRun = await coordinator
    .thread(notification.threadKey)
    .send(userInputToAgentInput(notification.input));
  await host.store.turns.update({ ...run, status: "completed" });
  return notificationRun;
}

function userInputToAgentInput(input: NotificationRecord["input"]): AgentInput {
  return "text" in input ? input.text : input.content;
}

async function claimOwnedNotification({
  host,
  idempotencyKey,
  ownerNamespace,
  parentThreadKey,
}: {
  readonly host: AgentHost;
  readonly idempotencyKey: string;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
}): Promise<NotificationRecord | null> {
  const current =
    await host.store.notifications.getByIdempotencyKey(idempotencyKey);
  if (
    current?.ownerNamespace !== ownerNamespace ||
    current.threadKey !== parentThreadKey
  ) {
    return null;
  }

  const claimed =
    await host.store.notifications.claimByIdempotencyKey(idempotencyKey);
  if (claimed.ok) {
    if (
      claimed.record.ownerNamespace === ownerNamespace &&
      claimed.record.threadKey === parentThreadKey
    ) {
      return claimed.record;
    }
    await host.store.notifications.releaseByIdempotencyKey(idempotencyKey);
    return null;
  }

  if (
    claimed.reason === "already-claimed" &&
    claimed.record?.ownerNamespace === ownerNamespace &&
    claimed.record.threadKey === parentThreadKey
  ) {
    return claimed.record;
  }

  return null;
}
