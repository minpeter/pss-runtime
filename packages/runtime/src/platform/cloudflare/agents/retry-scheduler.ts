import {
  prepareScheduledNotificationRetry,
  shouldRetryNotClaimableScheduledRun,
} from "../alarm/scheduled-work-context";
import type { CloudflareDurableObjectStorage } from "../host/durable-object-host";
import {
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsThreadFiberPayload,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  defaultCloudflareAgentsDelayedResumeCallback,
} from "./payload";
import { cloudflareAgentsDelayedSchedulePayload } from "./schedule-payload";
import {
  mirrorCloudflareAgentsScheduledPayload,
  removeCloudflareAgentsScheduledPayload,
} from "./scheduled-work";
import type {
  CloudflareAgentsCallbackName,
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsRetryFiber,
} from "./types";

const defaultRetryRunAfterMs = 1000;
const defaultRetryMaxAttempts = 5;
const defaultRetryMaxRunAfterMs = 60_000;

interface CloudflareAgentsDelayedCallbackOption<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly delayedResumeCallback?: CloudflareAgentsCallbackName<TAgent>;
}

export type CloudflareAgentsFiberRetrySchedulerOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = {
  readonly cloudflareAgent: TAgent;
  readonly retryMaxAttempts?: number;
  readonly retryMaxRunAfterMs?: number;
  readonly retryRunAfterMs?: number;
  readonly storage: CloudflareDurableObjectStorage;
} & CloudflareAgentsDelayedCallbackOption<TAgent>;

export function createCloudflareAgentsFiberRetryScheduler<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>(
  options: CloudflareAgentsFiberRetrySchedulerOptions<TAgent>
): CloudflareAgentsRetryFiber {
  const callback = delayedCallbackName(options);
  const {
    cloudflareAgent,
    retryMaxAttempts = defaultRetryMaxAttempts,
    retryMaxRunAfterMs = defaultRetryMaxRunAfterMs,
    retryRunAfterMs = defaultRetryRunAfterMs,
    storage,
  } = options;
  return async (payload, reason) => {
    if (
      reason === "not-claimable" &&
      !(await shouldRetryNotClaimableScheduledRun(
        storage,
        payload.prefix,
        payload.runId
      ))
    ) {
      return false;
    }
    const retryPayload = nextRetryPayload(payload);
    if ((retryPayload.attempt ?? 0) > Math.max(0, retryMaxAttempts)) {
      return false;
    }
    if (reason === "not-claimable") {
      const preparedNotification = await prepareScheduledNotificationRetry(
        storage,
        payload.prefix,
        payload.runId
      );
      if (!preparedNotification) {
        return false;
      }
    }
    const runAfterMs = retryDelayMs({
      attempt: retryPayload.attempt,
      maxRunAfterMs: retryMaxRunAfterMs,
      runAfterMs: retryRunAfterMs,
    });
    await mirrorCloudflareAgentsScheduledPayload({
      payload: retryPayload,
      runAfterMs,
      storage,
    });
    const scheduleDelaySeconds = delaySeconds(runAfterMs);
    try {
      await cloudflareAgent.schedule(
        scheduleDelaySeconds,
        callback,
        cloudflareAgentsDelayedSchedulePayload(
          retryPayload,
          scheduleDelaySeconds
        ),
        { idempotent: true }
      );
    } catch (error) {
      await removeCloudflareAgentsScheduledPayload(storage, retryPayload);
      throw error;
    }
    if (reason !== "not-claimable") {
      await prepareScheduledNotificationRetry(
        storage,
        payload.prefix,
        payload.runId
      );
    }
    return true;
  };
}

function retryDelayMs({
  attempt,
  maxRunAfterMs,
  runAfterMs,
}: {
  readonly attempt: number | undefined;
  readonly maxRunAfterMs: number;
  readonly runAfterMs: number;
}): number {
  const exponent = Math.max(0, (attempt ?? 1) - 1);
  return Math.min(
    Math.max(1, maxRunAfterMs),
    Math.max(1, runAfterMs) * 2 ** exponent
  );
}

function delaySeconds(runAfterMs: number): number {
  return Math.max(1, Math.ceil(runAfterMs / 1000));
}

function nextRetryPayload(
  payload: CloudflareAgentsFiberPayload
): CloudflareAgentsFiberPayload {
  const attempt = (payload.attempt ?? 0) + 1;
  switch (payload.kind) {
    case "run":
      return cloudflareAgentsRunPayload({
        attempt,
        prefix: payload.prefix,
        runId: payload.runId,
      });
    case "thread":
      return nextThreadRetryPayload(payload, attempt);
    default:
      return assertNeverPayload(payload);
  }
}

function nextThreadRetryPayload(
  payload: CloudflareAgentsThreadFiberPayload,
  attempt: number
): CloudflareAgentsThreadFiberPayload {
  return cloudflareAgentsThreadPayload({
    attempt,
    idempotencyKey: payload.idempotencyKey,
    notificationId: payload.notificationId,
    prefix: payload.prefix,
    runId: payload.runId,
    threadKey: payload.threadKey,
  });
}

function delayedCallbackName<TAgent extends CloudflareAgentsDefaultResumeAgent>(
  options: CloudflareAgentsDelayedCallbackOption<TAgent>
): CloudflareAgentsCallbackName<TAgent> {
  if (options.delayedResumeCallback !== undefined) {
    return options.delayedResumeCallback;
  }
  return defaultCloudflareAgentsDelayedResumeCallback;
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}
