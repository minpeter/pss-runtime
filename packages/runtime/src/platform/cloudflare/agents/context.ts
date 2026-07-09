import type { AgentHost } from "../../../execution";
import { recoverCloudflareAgentsFiber } from "./fiber";
import type { CloudflareHostAgentsOptions } from "../host/create-cloudflare-host";
import { createCloudflareHost } from "../host/create-cloudflare-host";
import { createCloudflareAgentsFiberRetryScheduler } from "./retry-scheduler";
import { resumeScheduledCloudflareAgentsFiber } from "./scheduled-fiber";
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
  readonly host: AgentHost;
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
  readonly retryMaxAttempts?: number;
  readonly retryMaxRunAfterMs?: number;
  readonly retryRunAfterMs?: number;
}

export type CloudflareAgentsPlatformContextOptions<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareAgentsPlatformContextBaseOptions<Env, CreatedAgent, TAgent> &
  Pick<CloudflareHostAgentsOptions<TAgent>, "delayedResumeCallback">;

export interface CloudflareAgentsPlatformContext<
  CreatedAgent extends CloudflareAgentsResumableAgent,
> {
  agent(prefix?: string): CreatedAgent;
  host(prefix?: string): AgentHost;
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
  retryMaxAttempts,
  retryMaxRunAfterMs,
  retryRunAfterMs,
}: CloudflareAgentsPlatformContextOptions<
  Env,
  CreatedAgent,
  TAgent
>): CloudflareAgentsPlatformContext<CreatedAgent> {
  const retry = createCloudflareAgentsFiberRetryScheduler({
    cloudflareAgent,
    delayedResumeCallback,
    retryMaxAttempts,
    retryMaxRunAfterMs,
    retryRunAfterMs,
    storage: durableObjectContext.storage,
  });
  const createHost = (prefix = contextDefaultPrefix): AgentHost =>
    createCloudflareHost({
      cloudflareAgent,
      delayedResumeCallback,
      drain,
      durableObjectContext,
      prefix,
      retryMaxAttempts,
      retryMaxRunAfterMs,
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
