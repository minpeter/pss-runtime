import {
  createCloudflareDurableObjectHost,
  drainCloudflareAlarm,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
} from "@minpeter/pss-runtime/cloudflare";
import { AgentDurableObject } from "../worker";
import { workerStorePrefix } from "../worker/constants";
import { createQueuedRun } from "./edge-case-helpers";
import { FailingRunLookupStorage } from "./failing-run-lookup-storage";

const sessionKey = "room:demo:user:edge";
const unclaimableAgent = { resume: () => Promise.resolve(null) };

export async function checkFailedAlarmKeepsRunScheduled(): Promise<boolean> {
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

export async function checkUnclaimableRunKeepsRunScheduled(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  const runId = "background:bg_leased";
  await createQueuedRun(host, {
    kind: "background-subagent",
    runId,
    sessionKey: "child:bg_leased",
  });
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

export async function checkUnclaimableSessionPromptKeepsPromptScheduled(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  const idempotencyKey = "background-complete:demo:bg_unclaimable";
  const runId = "notification:bg_unclaimable";
  await createQueuedRun(host, {
    kind: "notification",
    runId,
    sessionKey,
  });
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
