import {
  type CloudflareDurableObjectStorage,
  createCloudflareAlarmScheduler,
} from "../cloudflare";
import {
  claimScheduledCloudflareRun,
  claimScheduledCloudflareThreadPrompt,
} from "../cloudflare/host/durable-object-host";
import type {
  CloudflareAgentsFiberPayload,
  CloudflareAgentsThreadFiberPayload,
} from "./payload";

export async function mirrorCloudflareAgentsScheduledPayload({
  payload,
  runAfterMs,
  storage,
}: {
  readonly payload: CloudflareAgentsFiberPayload;
  readonly runAfterMs: number;
  readonly storage?: CloudflareDurableObjectStorage;
}): Promise<void> {
  if (storage === undefined) {
    return;
  }
  const scheduler = createCloudflareAlarmScheduler({
    prefix: payload.prefix,
    storage,
  });
  switch (payload.kind) {
    case "run":
      await scheduler.enqueueRun(payload.runId, { runAfterMs });
      return;
    case "thread":
      await scheduler.resumeThread(payload.threadKey, {
        idempotencyKey: payload.idempotencyKey,
        notificationId: payload.notificationId,
        runId: payload.runId,
      });
      return;
    default:
      return assertNeverPayload(payload);
  }
}

export async function claimCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<boolean> {
  switch (payload.kind) {
    case "run":
      return await claimRun(storage, payload.prefix, payload.runId);
    case "thread":
      return await claimThreadPrompt(storage, payload);
    default:
      return assertNeverPayload(payload);
  }
}

async function claimRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  return await claimScheduledCloudflareRun(storage, runId, { prefix });
}

async function claimThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<boolean> {
  const prompt = {
    idempotencyKey: payload.idempotencyKey,
    notificationId: payload.notificationId,
    runId: payload.runId,
    threadKey: payload.threadKey,
  };
  return await claimScheduledCloudflareThreadPrompt(storage, prompt, {
    prefix: payload.prefix,
  });
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}
