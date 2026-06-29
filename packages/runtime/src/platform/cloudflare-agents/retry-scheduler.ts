import type { CloudflareDurableObjectStorage } from "../cloudflare";
import {
  prepareScheduledNotificationRetry,
  shouldRetryNotClaimableScheduledRun,
} from "../cloudflare/alarm/scheduled-work-context";
import {
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsThreadFiberPayload,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  defaultCloudflareAgentsDelayedResumeCallback,
} from "./payload";
import { mirrorCloudflareAgentsScheduledPayload } from "./scheduled-work";
import type {
  CloudflareAgentsCallbackName,
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsRetryFiber,
} from "./types";

const defaultRetryRunAfterMs = 1000;

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
    await cloudflareAgent.schedule(
      delaySeconds(retryRunAfterMs),
      callback,
      retryPayload,
      { idempotent: true }
    );
    await mirrorCloudflareAgentsScheduledPayload({
      payload: retryPayload,
      runAfterMs: retryRunAfterMs,
      storage,
    });
    const preparedNotification = await prepareScheduledNotificationRetry(
      storage,
      payload.prefix,
      payload.runId
    );
    if (reason === "not-claimable" && !preparedNotification) {
      return false;
    }
    return true;
  };
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
