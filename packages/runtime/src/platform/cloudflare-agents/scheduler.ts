import type { ExecutionScheduler } from "../../execution";
import type { CloudflareDurableObjectStorage } from "../cloudflare";
import {
  prepareScheduledNotificationRetry,
  shouldRetryScheduledRun,
} from "../cloudflare/alarm/scheduled-work-context";
import { startCloudflareAgentsResumeFiber } from "./fiber";
import {
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsThreadFiberPayload,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  defaultCloudflareAgentsDelayedResumeCallback,
} from "./payload";
import type {
  CloudflareAgentsCallbackName,
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsResumeRun,
  CloudflareAgentsRetryFiber,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

const defaultPrefix = "pss-runtime";
const defaultRetryRunAfterMs = 1000;

interface CloudflareAgentsFiberSchedulerBaseOptions<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly cloudflareAgent: TAgent;
  readonly deadlineMs?: number;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly maxEvents?: number;
  readonly onEvent?: CloudflareAgentsTurnDrainOptions["onEvent"];
  readonly prefix?: string;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retry?: CloudflareAgentsRetryFiber;
}

interface CloudflareAgentsDelayedCallbackOption<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly delayedResumeCallback?: CloudflareAgentsCallbackName<TAgent>;
}

export type CloudflareAgentsFiberSchedulerOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareAgentsFiberSchedulerBaseOptions<TAgent> &
  CloudflareAgentsDelayedCallbackOption<TAgent>;

export type CloudflareAgentsFiberRetrySchedulerOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = {
  readonly cloudflareAgent: TAgent;
  readonly retryRunAfterMs?: number;
  readonly storage: CloudflareDurableObjectStorage;
} & CloudflareAgentsDelayedCallbackOption<TAgent>;

export function createCloudflareAgentsFiberScheduler<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>(options: CloudflareAgentsFiberSchedulerOptions<TAgent>): ExecutionScheduler {
  const {
    cloudflareAgent,
    deadlineMs,
    drain,
    maxEvents,
    onEvent,
    prefix = defaultPrefix,
    retry,
    resume,
  } = options;
  const delayedResumeCallback = delayedCallbackName(options);
  const drainOptions = mergeDrainOptions({
    deadlineMs,
    drain,
    maxEvents,
    onEvent,
  });
  const schedulePayload = (
    payload: CloudflareAgentsFiberPayload,
    runAfterMs?: number
  ) =>
    startOrSchedulePayload(
      {
        cloudflareAgent,
        delayedResumeCallback,
        drain: drainOptions,
        payload,
        retry,
        resume,
      },
      runAfterMs
    );
  return {
    enqueueRun: async (runId, options) => {
      await schedulePayload(
        cloudflareAgentsRunPayload({
          prefix,
          runId,
        }),
        options?.runAfterMs
      );
    },
    resumeThread: async (threadKey, options) => {
      await schedulePayload(
        cloudflareAgentsThreadPayload({
          idempotencyKey: options.idempotencyKey,
          notificationId: options.notificationId,
          prefix,
          runId: options.runId,
          threadKey,
        })
      );
    },
  };
}

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
      !(await shouldRetryScheduledRun(storage, payload.prefix, payload.runId))
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
    if (
      !(await prepareScheduledNotificationRetry(
        storage,
        payload.prefix,
        payload.runId
      ))
    ) {
      return false;
    }
    return true;
  };
}

async function startOrSchedulePayload<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
>(
  {
    cloudflareAgent,
    delayedResumeCallback,
    drain,
    payload,
    retry,
    resume,
  }: {
    readonly cloudflareAgent: TAgent;
    readonly delayedResumeCallback: CloudflareAgentsCallbackName<TAgent>;
    readonly drain?: CloudflareAgentsTurnDrainOptions;
    readonly payload: CloudflareAgentsFiberPayload;
    readonly retry?: CloudflareAgentsRetryFiber;
    readonly resume: CloudflareAgentsResumeRun;
  },
  runAfterMs?: number
): Promise<void> {
  if (runAfterMs !== undefined && runAfterMs > 0) {
    await cloudflareAgent.schedule(
      delaySeconds(runAfterMs),
      delayedResumeCallback,
      payload,
      { idempotent: true }
    );
    return;
  }

  await startCloudflareAgentsResumeFiber({
    cloudflareAgent,
    drain,
    payload,
    retry,
    resume,
  });
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

function mergeDrainOptions({
  deadlineMs,
  drain,
  maxEvents,
  onEvent,
}: {
  readonly deadlineMs?: number;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly maxEvents?: number;
  readonly onEvent?: CloudflareAgentsTurnDrainOptions["onEvent"];
}): CloudflareAgentsTurnDrainOptions | undefined {
  if (
    deadlineMs === undefined &&
    drain === undefined &&
    maxEvents === undefined &&
    onEvent === undefined
  ) {
    return;
  }
  return {
    deadlineMs: deadlineMs ?? drain?.deadlineMs,
    maxEvents: maxEvents ?? drain?.maxEvents,
    onEvent: onEvent ?? drain?.onEvent,
  };
}

function delayedCallbackName<TAgent extends CloudflareAgentsDefaultResumeAgent>(
  options: CloudflareAgentsDelayedCallbackOption<TAgent>
): CloudflareAgentsCallbackName<TAgent> {
  if (options.delayedResumeCallback !== undefined) {
    return options.delayedResumeCallback;
  }
  return defaultCloudflareAgentsDelayedResumeCallback as CloudflareAgentsCallbackName<TAgent>;
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}
