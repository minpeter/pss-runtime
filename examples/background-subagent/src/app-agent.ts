import type { Agent, AgentRun } from "@minpeter/pss-runtime";
import type {
  ExecutionHost,
  NotificationRecord,
  RunRecord,
} from "@minpeter/pss-runtime/execution";
import { readDurableBackgroundDelegationState } from "./background-delegation";
import { readerChildName } from "./delegate-tool";

export function createAppAgent(options: {
  readonly coordinator: Agent;
  readonly host: ExecutionHost;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly reader: Agent;
}): Agent {
  return {
    resume: async (runId: string) => {
      const run = await options.host.store.runs.get(runId);
      if (run?.runId.startsWith("background:")) {
        return await resumeBackgroundDelegation({
          host: options.host,
          ownerNamespace: options.ownerNamespace,
          parentThreadKey: options.parentThreadKey,
          reader: options.reader,
          run,
        });
      }

      if (run?.kind === "notification" && run.dedupeKey) {
        return await resumeCompletionNotification({
          coordinator: options.coordinator,
          dedupeKey: run.dedupeKey,
          host: options.host,
          ownerNamespace: options.ownerNamespace,
          parentThreadKey: options.parentThreadKey,
          run,
        });
      }

      return await options.coordinator.resume(runId);
    },
  } as Agent;
}

async function resumeBackgroundDelegation({
  host,
  ownerNamespace,
  parentThreadKey,
  reader,
  run,
}: {
  readonly host: ExecutionHost;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly reader: Agent;
  readonly run: RunRecord;
}): Promise<AgentRun | null> {
  if (run.status === "completed") {
    return null;
  }

  const checkpoint = await host.store.checkpoints.latest(run.runId);
  const state = readDurableBackgroundDelegationState(checkpoint);
  if (!state) {
    throw new Error(`Background task ${run.runId} is missing app state.`);
  }
  assertOwnedBackgroundRun({ ownerNamespace, parentThreadKey, run, state });

  await host.store.runs.update({ ...run, status: "running" });
  const childRun = await reader.thread(run.threadKey).send(state.prompt);
  const events = await collectRunEvents(childRun);
  const output = {
    result: "completed",
    subagent: readerChildName,
    text: collectAssistantText(events),
  };
  await host.store.runs.update({
    ...run,
    checkpointVersion: run.checkpointVersion,
    output,
    status: "completed",
  });
  await enqueueCompletionNotification({
    host,
    run,
    state,
  });

  return replayRun(events);
}

async function collectRunEvents(run: AgentRun) {
  const events: Awaited<ReturnType<AgentRun["events"]>> extends AsyncIterable<
    infer Event
  >
    ? Event[]
    : never[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

function collectAssistantText(
  events: Awaited<ReturnType<typeof collectRunEvents>>
): string {
  return events
    .filter((event) => event.type === "assistant-text")
    .map((event) => event.text)
    .join("\n");
}

async function enqueueCompletionNotification({
  host,
  run,
  state,
}: {
  readonly host: ExecutionHost;
  readonly run: RunRecord;
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
      type: "user-text",
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

  await host.store.runs.create({
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

async function resumeCompletionNotification({
  coordinator,
  dedupeKey,
  host,
  ownerNamespace,
  parentThreadKey,
  run,
}: {
  readonly coordinator: Agent;
  readonly dedupeKey: string;
  readonly host: ExecutionHost;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly run: RunRecord;
}): Promise<AgentRun | null> {
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
    .send(notification.input);
  await host.store.runs.update({ ...run, status: "completed" });
  return notificationRun;
}

async function claimOwnedNotification({
  host,
  idempotencyKey,
  ownerNamespace,
  parentThreadKey,
}: {
  readonly host: ExecutionHost;
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

function assertOwnedBackgroundRun({
  ownerNamespace,
  parentThreadKey,
  run,
  state,
}: {
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly run: RunRecord;
  readonly state: NonNullable<
    ReturnType<typeof readDurableBackgroundDelegationState>
  >;
}): void {
  if (run.ownerNamespace !== ownerNamespace) {
    throw new Error(`Background task ${run.runId} is not owned by this app.`);
  }

  if (state.parentThreadKey !== parentThreadKey) {
    throw new Error(
      `Background task ${run.runId} is not linked to this session.`
    );
  }

  if (state.subagent !== readerChildName) {
    throw new Error(`Background task ${run.runId} has an unknown worker.`);
  }
}

function replayRun(
  events: Awaited<ReturnType<typeof collectRunEvents>>
): AgentRun {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(
  events: Awaited<ReturnType<typeof collectRunEvents>>
) {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
