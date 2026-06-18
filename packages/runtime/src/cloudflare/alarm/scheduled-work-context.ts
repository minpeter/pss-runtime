import type { RunStatus } from "../../execution";
import {
  type CloudflareDurableObjectStorage,
  type CloudflareScheduledSessionPrompt,
  createCloudflareDurableObjectHost,
} from "../host/durable-object-host";
import type { CloudflareAlarmRunContext } from "./drainer";

export async function scheduledRunContext(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<CloudflareAlarmRunContext> {
  const run = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.runs.get(runId);
  return {
    runId,
    sessionKey: run?.sessionKey ?? "",
    source: "scheduled-run",
  };
}

export async function scheduledSessionPromptContext(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledSessionPrompt
): Promise<CloudflareAlarmRunContext | undefined> {
  const runId = await scheduledSessionPromptRunId(storage, prefix, prompt);
  if (!runId) {
    return;
  }

  return {
    idempotencyKey: prompt.idempotencyKey,
    notificationId: prompt.notificationId,
    runId,
    sessionKey: prompt.sessionKey,
    source: "session-prompt",
  };
}

export async function shouldRetryScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  const run = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.runs.get(runId);
  return run ? isRetryableRunStatus(run.status) : true;
}

export async function shouldRetryScheduledSessionPrompt(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledSessionPrompt
): Promise<boolean> {
  const runId = await scheduledSessionPromptRunId(storage, prefix, prompt);
  return runId
    ? await shouldRetryScheduledRun(storage, prefix, runId)
    : prompt.idempotencyKey !== undefined;
}

export function sessionPromptId(
  prompt: CloudflareScheduledSessionPrompt
): string {
  return prompt.idempotencyKey ?? prompt.runId ?? "<missing-run-id>";
}

async function scheduledSessionPromptRunId(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledSessionPrompt
): Promise<string | undefined> {
  if (prompt.runId) {
    return prompt.runId;
  }
  if (!prompt.idempotencyKey) {
    return;
  }

  const notification = await createCloudflareDurableObjectHost({
    prefix,
    storage,
  }).store.notifications.getByIdempotencyKey(prompt.idempotencyKey);
  return notification?.runId;
}

function isRetryableRunStatus(status: RunStatus | undefined): boolean {
  return (
    status === "leased" ||
    status === "queued" ||
    status === "running" ||
    status === "suspended"
  );
}
