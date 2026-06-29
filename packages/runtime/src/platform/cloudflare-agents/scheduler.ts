import type { ExecutionScheduler } from "../../execution";
import { startCloudflareAgentsResumeFiber } from "./fiber";
import {
  type CloudflareAgentsFiberPayload,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  defaultCloudflareAgentsDelayedResumeCallback,
} from "./payload";
import type {
  CloudflareAgentsCallbackName,
  CloudflareAgentsPlatformAgent,
  CloudflareAgentsResumeRun,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

const defaultPrefix = "pss-runtime";

export interface CloudflareAgentsFiberSchedulerOptions<
  TAgent extends CloudflareAgentsPlatformAgent = CloudflareAgentsPlatformAgent,
> {
  readonly cloudflareAgent: TAgent;
  readonly deadlineMs?: number;
  readonly delayedResumeCallback?: string;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly maxEvents?: number;
  readonly onEvent?: CloudflareAgentsTurnDrainOptions["onEvent"];
  readonly prefix?: string;
  readonly resume: CloudflareAgentsResumeRun;
}

export function createCloudflareAgentsFiberScheduler<
  TAgent extends CloudflareAgentsPlatformAgent,
>({
  cloudflareAgent,
  delayedResumeCallback = defaultCloudflareAgentsDelayedResumeCallback,
  deadlineMs,
  drain,
  maxEvents,
  onEvent,
  prefix = defaultPrefix,
  resume,
}: CloudflareAgentsFiberSchedulerOptions<TAgent>): ExecutionScheduler {
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
        delayedResumeCallback:
          delayedResumeCallback as CloudflareAgentsCallbackName<TAgent>,
        drain: drainOptions,
        payload,
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

async function startOrSchedulePayload<
  TAgent extends CloudflareAgentsPlatformAgent,
>(
  {
    cloudflareAgent,
    delayedResumeCallback,
    drain,
    payload,
    resume,
  }: {
    readonly cloudflareAgent: TAgent;
    readonly delayedResumeCallback: CloudflareAgentsCallbackName<TAgent>;
    readonly drain?: CloudflareAgentsTurnDrainOptions;
    readonly payload: CloudflareAgentsFiberPayload;
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
    resume,
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
