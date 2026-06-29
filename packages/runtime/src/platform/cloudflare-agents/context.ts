import type { ExecutionHost } from "../../execution";
import {
  recoverCloudflareAgentsFiber,
  resumeScheduledCloudflareAgentsFiber,
} from "./fiber";
import { createCloudflareAgentsExecutionHost } from "./host";
import type {
  CloudflareAgentsPayloadTrustOptions,
  CloudflareAgentsPrefixGuardOptions,
} from "./trust";
import type {
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

export interface CloudflareAgentsPlatformFactoryOptions<Env> {
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
  readonly host: ExecutionHost;
  readonly prefix: string;
}

export interface CloudflareAgentsPlatformContextOptions<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
> {
  readonly allowedPrefixes?: readonly string[];
  readonly allowPrefix?: CloudflareAgentsPlatformPrefixGuard<Env>;
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly createAgent: (
    options: CloudflareAgentsPlatformFactoryOptions<Env>
  ) => CreatedAgent;
  readonly defaultPrefix?: string;
  readonly delayedResumeCallback?: string;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
}

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
}: CloudflareAgentsPlatformContextOptions<
  Env,
  CreatedAgent
>): CloudflareAgentsPlatformContext<CreatedAgent> {
  const createHost = (prefix = contextDefaultPrefix): ExecutionHost =>
    createCloudflareAgentsExecutionHost({
      cloudflareAgent,
      delayedResumeCallback,
      drain,
      durableObjectContext,
      prefix,
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
        resume: async (payload): ReturnType<CloudflareAgentsResumeRun> =>
          await createContextAgent(payload.prefix).resume(payload.runId),
        ...trust,
      }),
    resumeScheduledFiber: async (payload) =>
      await resumeScheduledCloudflareAgentsFiber({
        cloudflareAgent,
        drain,
        payload,
        resume: async (payload): ReturnType<CloudflareAgentsResumeRun> =>
          await createContextAgent(payload.prefix).resume(payload.runId),
        ...trust,
      }),
  };
}
