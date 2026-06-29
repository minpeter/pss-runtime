import type { ExecutionHost } from "../../execution";
import type { ThreadStore } from "../../thread/store/types";
import { createCloudflareDurableObjectHost } from "../cloudflare";
import { createCloudflareAgentsFiberRetryScheduler } from "./retry-scheduler";
import {
  type CloudflareAgentsFiberSchedulerOptions,
  createCloudflareAgentsFiberScheduler,
} from "./scheduler";
import type {
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsResumeRun,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

const defaultPrefix = "pss-runtime";

interface CloudflareAgentsExecutionHostBaseOptions<
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly cloudflareAgent: TAgent;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retryRunAfterMs?: number;
  readonly threadStore?: ThreadStore;
}

export type CloudflareAgentsExecutionHostOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareAgentsExecutionHostBaseOptions<TAgent> &
  Pick<CloudflareAgentsFiberSchedulerOptions<TAgent>, "delayedResumeCallback">;

export function createCloudflareAgentsExecutionHost<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>({
  cloudflareAgent,
  delayedResumeCallback,
  drain,
  durableObjectContext,
  maxPayloadBytes,
  prefix = defaultPrefix,
  retryRunAfterMs,
  resume,
  threadStore,
}: CloudflareAgentsExecutionHostOptions<TAgent>): ExecutionHost {
  const retry = createCloudflareAgentsFiberRetryScheduler({
    cloudflareAgent,
    delayedResumeCallback,
    retryRunAfterMs,
    storage: durableObjectContext.storage,
  });
  return createCloudflareDurableObjectHost({
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
