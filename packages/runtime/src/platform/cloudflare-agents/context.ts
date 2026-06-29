import type { ExecutionHost } from "../../execution";
import {
  recoverCloudflareAgentsFiber,
  resumeScheduledCloudflareAgentsFiber,
} from "./fiber";
import {
  type CloudflareAgentsExecutionHostOptions,
  createCloudflareAgentsExecutionHost,
} from "./host";
import { createCloudflareAgentsFiberRetryScheduler } from "./retry-scheduler";
import type {
  CloudflareAgentsPayloadTrustOptions,
  CloudflareAgentsPrefixGuardOptions,
} from "./trust";
import type {
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsFiberRecoveryResult,
  CloudflareAgentsPlatformAgent,
  CloudflareAgentsResumeRun,
  CloudflareAgentsStartFiberResult,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

const defaultPrefix = "pss-runtime";

type MaybePromise<T> = Promise<T> | T;

export interface CloudflareAgentsPlatformFactoryOptions<
  Env,
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> {
  readonly cloudflareAgent: TAgent;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
  readonly host: ExecutionHost;
  readonly prefix: string;
}

interface CloudflareAgentsPlatformContextBaseOptions<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly allowedPrefixes?: readonly string[];
  readonly allowPrefix?: CloudflareAgentsPlatformPrefixGuard<Env>;
  readonly cloudflareAgent: TAgent;
  readonly createAgent: (
    options: CloudflareAgentsPlatformFactoryOptions<Env, TAgent>
  ) => CreatedAgent;
  readonly defaultPrefix?: string;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
  readonly retryRunAfterMs?: number;
}

export type CloudflareAgentsPlatformContextOptions<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareAgentsPlatformContextBaseOptions<Env, CreatedAgent, TAgent> &
  Pick<CloudflareAgentsExecutionHostOptions<TAgent>, "delayedResumeCallback">;

export interface CloudflareAgentsPlatformContext<
  CreatedAgent extends CloudflareAgentsResumableAgent,
> {
  agent(prefix?: string): CreatedAgent;
  host(prefix?: string): ExecutionHost;
  recoverFiber(
    ctx: CloudflareAgentsFiberRecoveryContext
  ): Promise<CloudflareAgentsFiberRecoveryResult | false>;
  resumeScheduledFiber(
    payload: unknown
  ): Promise<CloudflareAgentsStartFiberResult>;
}

export interface CloudflareAgentsResumableAgent {
  resume(runId: string): ReturnType<CloudflareAgentsResumeRun>;
}

export type CloudflareAgentsPlatformPrefixGuard<Env> = (
  options: CloudflareAgentsPlatformPrefixGuardOptions<Env>
) => MaybePromise<boolean>;

export interface CloudflareAgentsPlatformPrefixGuardOptions<Env>
  extends CloudflareAgentsPrefixGuardOptions {
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
}

export function createCloudflareAgentsPlatformContext<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>({
  allowPrefix,
  allowedPrefixes,
  cloudflareAgent,
  createAgent,
  defaultPrefix: contextDefaultPrefix = defaultPrefix,
  delayedResumeCallback,
  drain,
  durableObjectContext,
  env,
  retryRunAfterMs,
}: CloudflareAgentsPlatformContextOptions<
  Env,
  CreatedAgent,
  TAgent
>): CloudflareAgentsPlatformContext<CreatedAgent> {
  const retry = createCloudflareAgentsFiberRetryScheduler({
    cloudflareAgent,
    delayedResumeCallback,
    retryRunAfterMs,
    storage: durableObjectContext.storage,
  });
  const createHost = (prefix = contextDefaultPrefix): ExecutionHost =>
    createCloudflareAgentsExecutionHost({
      cloudflareAgent,
      delayedResumeCallback,
      drain,
      durableObjectContext,
      prefix,
      retryRunAfterMs,
      resume: async (payload): ReturnType<CloudflareAgentsResumeRun> =>
        await createContextAgent(payload.prefix).resume(payload.runId),
    });
  const createContextAgent = (prefix = contextDefaultPrefix): CreatedAgent =>
    createAgent({
      cloudflareAgent,
      durableObjectContext,
      env,
      host: createHost(prefix),
      prefix,
    });
  const trust: CloudflareAgentsPayloadTrustOptions = {
    allowPrefix: allowPrefix
      ? (options) =>
          allowPrefix({
            cloudflareAgent,
            durableObjectContext,
            env,
            ...options,
          })
      : undefined,
    allowedPrefixes:
      allowedPrefixes ?? (allowPrefix ? undefined : [contextDefaultPrefix]),
  };

  return {
    agent: createContextAgent,
    host: createHost,
    recoverFiber: async (ctx) =>
      await recoverCloudflareAgentsFiber({
        ctx,
        drain,
        retry,
        resume: async (payload): ReturnType<CloudflareAgentsResumeRun> =>
          await createContextAgent(payload.prefix).resume(payload.runId),
        storage: durableObjectContext.storage,
        ...trust,
      }),
    resumeScheduledFiber: async (payload) =>
      await resumeScheduledCloudflareAgentsFiber({
        cloudflareAgent,
        drain,
        payload,
        retry,
        resume: async (payload): ReturnType<CloudflareAgentsResumeRun> =>
          await createContextAgent(payload.prefix).resume(payload.runId),
        storage: durableObjectContext.storage,
        ...trust,
      }),
  };
}
