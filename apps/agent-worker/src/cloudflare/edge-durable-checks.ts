import {
  ackScheduledCloudflareRun,
  createCloudflareDurableObjectHost,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
} from "@minpeter/pss-runtime/cloudflare";
import { createWorkerCoordinator } from "../agent/factory";
import { workerStorePrefix } from "../worker/constants";
import {
  backgroundNotificationKey,
  backgroundTaskIdFromEvents,
  collectEvents,
  createQueuedRun,
} from "./edge-case-helpers";

const sessionKey = "room:demo:user:edge";

export async function checkDuplicateAlarmDelivery(): Promise<boolean> {
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

export async function checkCancelledRunNotification(): Promise<boolean> {
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
    backgroundNotificationKey(sessionKey, taskId)
  );
  return resumed === null && notification === null;
}

export async function checkStaleCheckpoint(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  await createQueuedRun(host, {
    kind: "background-subagent",
    runId: "background:bg_stale",
    sessionKey: "child:bg_stale",
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

export async function checkMalformedSessionPrompt(): Promise<boolean> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const agent = createWorkerCoordinator(storage);
  return (await agent.resume("notification:not-a-real-notification")) === null;
}
