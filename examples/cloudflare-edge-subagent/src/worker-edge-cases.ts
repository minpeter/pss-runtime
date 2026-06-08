import type { AgentEvent } from "@minpeter/pss-runtime";
import { drainCloudflareAlarm } from "./cloudflare-alarm-drainer";
import {
  ackScheduledCloudflareRun,
  createCloudflareDurableObjectHost,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
} from "./cloudflare-host";
import { FailingRunLookupStorage } from "./failing-run-lookup-storage";
import {
  AgentDurableObject,
  createWorkerCoordinator,
  workerStorePrefix,
} from "./worker";

const sessionKey = "room:demo:user:edge";
const noRun = () => Promise.resolve(null);
const unclaimableAgent = { resume: noRun };

async function checkDuplicateAlarmDelivery(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  await host.scheduler.enqueueRun("background:bg_duplicate");
  await host.scheduler.enqueueRun("background:bg_duplicate");

  const first = await listScheduledCloudflareRuns(storage, {
    prefix: workerStorePrefix,
  });
  await ackScheduledCloudflareRun(storage, "background:bg_duplicate", {
    prefix: workerStorePrefix,
  });
  const second = await listScheduledCloudflareRuns(storage, {
    prefix: workerStorePrefix,
  });
  return (
    first.length === 1 &&
    first[0] === "background:bg_duplicate" &&
    second.length === 0
  );
}

async function checkCancelledRunNotification(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const agent = createWorkerCoordinator(storage);
  const launchEvents = await collectEvents(
    await agent.session(sessionKey).send("Start background research.")
  );
  const taskId = backgroundTaskIdFromEvents(launchEvents);
  const runId = (
    await listScheduledCloudflareRuns(storage, {
      prefix: workerStorePrefix,
    })
  )[0];
  if (!runId) {
    throw new Error("Background run was not scheduled.");
  }

  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  const run = await host.store.runs.get(runId);
  if (!run) {
    throw new Error("Background run record was not stored.");
  }
  await host.store.runs.update({ ...run, status: "cancelled" });

  const resumed = await agent.resume(runId);
  const notification = await host.store.notifications.getByIdempotencyKey(
    backgroundNotificationKey(taskId)
  );
  return resumed === null && notification === null;
}

async function checkStaleCheckpoint(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  await host.store.runs.create({
    checkpointVersion: 0,
    kind: "background-subagent",
    rootRunId: "background:bg_stale",
    runId: "background:bg_stale",
    sessionKey: "child:bg_stale",
    status: "queued",
  });

  const first = await host.store.checkpoints.append(
    {
      checkpointId: "checkpoint-1",
      phase: "before-model",
      runId: "background:bg_stale",
      runtimeState: {},
      sessionSnapshot: {},
      version: 1,
    },
    { expectedVersion: 0 }
  );
  const stale = await host.store.checkpoints.append(
    {
      checkpointId: "checkpoint-2",
      phase: "after-model",
      runId: "background:bg_stale",
      runtimeState: {},
      sessionSnapshot: {},
      version: 2,
    },
    { expectedVersion: 0 }
  );

  return first.ok && !stale.ok && stale.reason === "stale-version";
}

async function checkMalformedSessionPrompt(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const agent = createWorkerCoordinator(storage);
  return (await agent.resume("notification:not-a-real-notification")) === null;
}

async function checkFailedAlarmKeepsRunScheduled(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  const runId = "background:bg_retry";
  await host.scheduler.enqueueRun(runId);

  const failingStorage = new FailingRunLookupStorage(storage, runId);
  const summary = await new AgentDurableObject(
    {
      storage: failingStorage,
      waitUntil: () => undefined,
    },
    {}
  ).alarm();
  const pendingRuns = await listScheduledCloudflareRuns(storage, {
    prefix: workerStorePrefix,
  });

  return (
    summary.failedRuns.length === 1 &&
    summary.failedRuns[0]?.id === runId &&
    pendingRuns.length === 1 &&
    pendingRuns[0] === runId &&
    storage.alarmTime() !== undefined
  );
}

async function checkUnclaimableRunKeepsRunScheduled(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  const runId = "background:bg_leased";
  await host.scheduler.enqueueRun(runId);

  const summary = await drainCloudflareAlarm({
    agent: unclaimableAgent,
    prefix: workerStorePrefix,
    storage,
  });
  const pendingRuns = await listScheduledCloudflareRuns(storage, {
    prefix: workerStorePrefix,
  });

  return (
    summary.failedRuns.length === 1 &&
    summary.failedRuns[0]?.id === runId &&
    pendingRuns.length === 1 &&
    pendingRuns[0] === runId &&
    storage.alarmTime() !== undefined
  );
}

async function checkUnclaimableSessionPromptKeepsPromptScheduled(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  const idempotencyKey = "background-complete:demo:bg_unclaimable";
  const runId = "notification:bg_unclaimable";
  await host.scheduler.resumeSession(sessionKey, { idempotencyKey, runId });

  const summary = await drainCloudflareAlarm({
    agent: unclaimableAgent,
    prefix: workerStorePrefix,
    storage,
  });
  const pendingPrompts = await listScheduledCloudflareSessionPrompts(storage, {
    prefix: workerStorePrefix,
  });

  return (
    summary.failedSessionPrompts.length === 1 &&
    summary.failedSessionPrompts[0]?.id === idempotencyKey &&
    pendingPrompts.length === 1 &&
    pendingPrompts[0]?.idempotencyKey === idempotencyKey &&
    pendingPrompts[0]?.runId === runId &&
    storage.alarmTime() !== undefined
  );
}

async function collectEvents(run: {
  events(): AsyncIterable<AgentEvent>;
}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

function backgroundTaskIdFromEvents(events: readonly AgentEvent[]): string {
  for (const event of events) {
    if (event.type !== "tool-result") {
      continue;
    }
    const output = event.output;
    if (
      isRecord(output) &&
      output.type === "json" &&
      isRecord(output.value) &&
      typeof output.value.task_id === "string"
    ) {
      return output.value.task_id;
    }
  }

  throw new Error("Background task id was not emitted.");
}

const backgroundNotificationKey = (taskId: string) =>
  `background-complete:${sessionKey}:${taskId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const duplicateAlarmIdempotent = await checkDuplicateAlarmDelivery();
const cancelledRunSkippedNotification = await checkCancelledRunNotification();
const staleCheckpointRejected = await checkStaleCheckpoint();
const malformedSessionPromptRejected = await checkMalformedSessionPrompt();
const failedAlarmKeepsRunScheduled = await checkFailedAlarmKeepsRunScheduled();
const unclaimableRunKeepsRunScheduled =
  await checkUnclaimableRunKeepsRunScheduled();
const unclaimableSessionPromptKeepsPromptScheduled =
  await checkUnclaimableSessionPromptKeepsPromptScheduled();

console.log({ duplicateAlarmIdempotent });
console.log({ cancelledRunSkippedNotification });
console.log({ staleCheckpointRejected });
console.log({ malformedSessionPromptRejected });
console.log({ failedAlarmKeepsRunScheduled });
console.log({ unclaimableRunKeepsRunScheduled });
console.log({ unclaimableSessionPromptKeepsPromptScheduled });

if (
  !(
    duplicateAlarmIdempotent &&
    cancelledRunSkippedNotification &&
    staleCheckpointRejected &&
    malformedSessionPromptRejected &&
    failedAlarmKeepsRunScheduled &&
    unclaimableRunKeepsRunScheduled &&
    unclaimableSessionPromptKeepsPromptScheduled
  )
) {
  throw new Error("Cloudflare edge-case checks failed.");
}
