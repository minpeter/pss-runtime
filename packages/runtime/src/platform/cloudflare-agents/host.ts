import type { ExecutionHost } from "../../execution";
import type { ThreadStore } from "../../thread/store/types";
import { createCloudflareDurableObjectHost } from "../cloudflare";
import { createCloudflareAgentsFiberScheduler } from "./scheduler";
import type {
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsPlatformAgent,
  CloudflareAgentsResumeRun,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

const defaultPrefix = "pss-runtime";

export interface CloudflareAgentsExecutionHostOptions {
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly delayedResumeCallback?: string;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly resume: CloudflareAgentsResumeRun;
  readonly threadStore?: ThreadStore;
}

export function createCloudflareAgentsExecutionHost({
  cloudflareAgent,
  delayedResumeCallback,
  drain,
  durableObjectContext,
  maxPayloadBytes,
  prefix = defaultPrefix,
  resume,
  threadStore,
}: CloudflareAgentsExecutionHostOptions): ExecutionHost {
  return createCloudflareDurableObjectHost({
    maxPayloadBytes,
    prefix,
    scheduler: createCloudflareAgentsFiberScheduler({
      cloudflareAgent,
      delayedResumeCallback,
      drain,
      prefix,
      resume,
    }),
    storage: durableObjectContext.storage,
    threadStore,
  });
}
