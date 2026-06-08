import type { AgentEvent } from "@minpeter/pss-runtime";
import {
  createCloudflareDurableObjectHost,
  InMemoryCloudflareDurableObjectStorage,
} from "./cloudflare-host";
import {
  AgentDurableObject,
  type CloudflareDurableObjectState,
  createWorkerCoordinator,
  workerStorePrefix,
} from "./worker";

const sessionKey = "room:demo:user:edge";

const storage = new InMemoryCloudflareDurableObjectStorage();
const state: CloudflareDurableObjectState = {
  storage,
  waitUntil: (promise) => {
    promise.catch((error: unknown) => {
      console.error(error);
    });
  },
};

const launchObject = new AgentDurableObject(state, {});
const launchResponse = await launchObject.fetch(
  new Request("https://worker.example/turn", {
    body: JSON.stringify({
      input:
        "Start background research on why stable task ids matter in edge-hosted agent turns.",
    }),
    method: "POST",
  })
);
const launchBody = await readResponseJson(launchResponse);
const launchEvents = readEvents(launchBody);
const taskId = backgroundTaskIdFromEvents(launchEvents);

console.log("request-boundary:launch", taskId);
console.log("alarmScheduled", storage.alarmTime() !== undefined);

const alarmObject = new AgentDurableObject(state, {});
const alarmSummary = await alarmObject.alarm();

console.log("alarm:resume", alarmSummary.resumedRuns);
console.log("resume:session-prompt", alarmSummary.consumedSessionPrompts);
console.log("finalAnswer", extractFinalAnswer(alarmSummary.events));

const duplicate = await createWorkerCoordinator(storage).resume(
  await notificationRunId(backgroundNotificationKey(taskId))
);
console.log({ duplicateSessionPromptIgnored: duplicate === null });

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

function extractFinalAnswer(events: readonly AgentEvent[]): string {
  const assistantText = events.find(
    (event): event is Extract<AgentEvent, { type: "assistant-text" }> =>
      event.type === "assistant-text"
  );
  if (!assistantText) {
    throw new Error("Final assistant answer was not emitted.");
  }
  return assistantText.text;
}

function backgroundNotificationKey(taskId: string): string {
  return `background-complete:${sessionKey}:${taskId}`;
}

async function notificationRunId(notificationKey: string): Promise<string> {
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
    storage,
  });
  const notification =
    await host.store.notifications.getByIdempotencyKey(notificationKey);
  if (!notification) {
    throw new Error(`Notification ${notificationKey} was not enqueued.`);
  }
  return notification.runId;
}

async function readResponseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Worker response failed with ${response.status}.`);
  }
  return await response.json();
}

function readEvents(value: unknown): readonly AgentEvent[] {
  if (isRecord(value) && Array.isArray(value.events)) {
    return value.events as AgentEvent[];
  }

  throw new Error("Worker response did not include events.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
