import type { ExecutionScheduler } from "../../execution";
import type { CloudflareDurableObjectStorage } from "../cloudflare";
import { startCloudflareAgentsResumeFiber } from "./fiber";
import {
  type CloudflareAgentsFiberPayload,
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
  CloudflareAgentsResumeRun,
  CloudflareAgentsRetryFiber,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

const defaultPrefix = "pss-runtime";

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
  readonly storage?: CloudflareDurableObjectStorage;
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
    storage,
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
        storage,
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
    storage,
  }: {
    readonly cloudflareAgent: TAgent;
    readonly delayedResumeCallback: CloudflareAgentsCallbackName<TAgent>;
    readonly drain?: CloudflareAgentsTurnDrainOptions;
    readonly payload: CloudflareAgentsFiberPayload;
    readonly retry?: CloudflareAgentsRetryFiber;
    readonly resume: CloudflareAgentsResumeRun;
    readonly storage?: CloudflareDurableObjectStorage;
  },
  runAfterMs?: number
): Promise<void> {
  if (runAfterMs !== undefined && runAfterMs > 0) {
    const scheduleDelaySeconds = delaySeconds(runAfterMs);
    await mirrorCloudflareAgentsScheduledPayload({
      payload,
      runAfterMs,
      storage,
    });
    try {
      await cloudflareAgent.schedule(
        scheduleDelaySeconds,
        delayedResumeCallback,
        cloudflareAgentsDelayedSchedulePayload(payload, scheduleDelaySeconds),
        { idempotent: true }
      );
    } catch (error) {
      if (storage !== undefined) {
        await removeCloudflareAgentsScheduledPayload(storage, payload);
      }
      throw error;
    }
    return;
  }

  await startCloudflareAgentsResumeFiber({
    cloudflareAgent,
    drain,
    payload,
    retry,
    resume,
    storage,
  });
}

function delaySeconds(runAfterMs: number): number {
  return Math.max(1, Math.ceil(runAfterMs / 1000));
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
  return defaultCloudflareAgentsDelayedResumeCallback;
}
