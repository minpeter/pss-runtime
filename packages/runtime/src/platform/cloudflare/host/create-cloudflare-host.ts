import type { AgentHost, ExecutionScheduler } from "../../../execution";
import type { ThreadStore } from "../../../thread/store/types";
import { createCloudflareAgentsFiberRetryScheduler } from "../agents/retry-scheduler";
import {
  type CloudflareAgentsFiberSchedulerOptions,
  createCloudflareAgentsFiberScheduler,
} from "../agents/scheduler";
import type {
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsResumeRun,
  CloudflareAgentsTurnDrainOptions,
} from "../agents/types";
import {
  createCloudflareAlarmScheduler,
  createCloudflareStorageHost,
  type CloudflareStorageHostOptions,
} from "./durable-object-host";

const defaultPrefix = "pss-runtime";

export type { CloudflareStorageHostOptions };

interface CloudflareHostAgentsBaseOptions<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly cloudflareAgent: TAgent;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retryMaxAttempts?: number;
  readonly retryMaxRunAfterMs?: number;
  readonly retryRunAfterMs?: number;
  readonly threadStore?: ThreadStore;
}

/** Agents SDK fiber/schedule host options (superset path). */
export type CloudflareHostAgentsOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareHostAgentsBaseOptions<TAgent> &
  Pick<CloudflareAgentsFiberSchedulerOptions<TAgent>, "delayedResumeCallback">;

/** Plain DO storage + alarm host options. */
export type CloudflareHostStorageOptions = CloudflareStorageHostOptions;

/**
 * Create a Cloudflare AgentHost.
 *
 * - Storage-only: DO storage + alarm scheduler.
 * - With `cloudflareAgent` + `resume` + `durableObjectContext`: Agents fiber
 *   scheduler on the same DO storage (superset path).
 */
export function createCloudflareHost<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
>(options: CloudflareHostAgentsOptions<TAgent>): AgentHost;
export function createCloudflareHost(
  options: CloudflareHostStorageOptions
): AgentHost;
export function createCloudflareHost<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
>(
  options: CloudflareHostAgentsOptions<TAgent> | CloudflareHostStorageOptions
): AgentHost {
  if (isAgentsHostOptions(options)) {
    return createAgentsCloudflareHost(options);
  }
  return createCloudflareStorageHost(options);
}

function createAgentsCloudflareHost<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
>({
  cloudflareAgent,
  delayedResumeCallback,
  drain,
  durableObjectContext,
  maxPayloadBytes,
  prefix = defaultPrefix,
  retryMaxAttempts,
  retryMaxRunAfterMs,
  retryRunAfterMs,
  resume,
  threadStore,
}: CloudflareHostAgentsOptions<TAgent>): AgentHost {
  const retry = createCloudflareAgentsFiberRetryScheduler({
    cloudflareAgent,
    delayedResumeCallback,
    retryMaxAttempts,
    retryMaxRunAfterMs,
    retryRunAfterMs,
    storage: durableObjectContext.storage,
  });
  return createCloudflareStorageHost({
    maxPayloadBytes,
    prefix,
    scheduler: createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      delayedResumeCallback,
      drain,
      prefix,
      retry,
      resume,
      storage: durableObjectContext.storage,
    }),
    storage: durableObjectContext.storage,
    threadStore,
  });
}

function isAgentsHostOptions<TAgent extends CloudflareAgentsDefaultResumeAgent>(
  options: CloudflareHostAgentsOptions<TAgent> | CloudflareHostStorageOptions
): options is CloudflareHostAgentsOptions<TAgent> {
  return (
    "cloudflareAgent" in options &&
    "resume" in options &&
    "durableObjectContext" in options
  );
}

export {
  createCloudflareAlarmScheduler,
  type CloudflareStorageHostOptions as CloudflareHostBaseOptions,
};

export type { ExecutionScheduler };
