import type { AgentHost } from "../../../execution";
import type { CloudflareAlarmDrainBudget } from "../alarm/budget";
import type {
  CloudflareAlarmAgent,
  CloudflareAlarmDrainSummary,
} from "../alarm/drainer";
import { drainCloudflareAlarm } from "../alarm/drainer";
import { createCloudflareStorageHost } from "../host/durable-object-host";
import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";

const defaultContextPrefix = "pss-runtime";

type MaybePromise<T> = Promise<T> | T;

export interface CloudflareAgentContextFactoryOptions<Env> {
  readonly env: Env;
  readonly host: AgentHost;
  readonly prefix: string;
  readonly storage: CloudflareDurableObjectStorage;
}

export interface CloudflareAgentContextPrefixOptions<Env> {
  readonly env: Env;
  readonly storage: CloudflareDurableObjectStorage;
}

export interface CloudflareAgentContextOptions<
  Env,
  Agent extends CloudflareAlarmAgent,
> {
  readonly createAgent: (
    options: CloudflareAgentContextFactoryOptions<Env>
  ) => Agent;
  readonly defaultPrefix?: string;
  readonly env: Env;
  readonly readPrefix?: (
    options: CloudflareAgentContextPrefixOptions<Env>
  ) => MaybePromise<string | undefined>;
  readonly storage: CloudflareDurableObjectStorage;
}

export interface CloudflareAgentContext<Agent extends CloudflareAlarmAgent> {
  agent(prefix?: string): Agent;
  drainAlarm(
    budget?: CloudflareAlarmDrainBudget
  ): Promise<CloudflareAlarmDrainSummary>;
  host(prefix?: string): AgentHost;
  readonly storage: CloudflareDurableObjectStorage;
}

export function createCloudflareAgentContext<
  Env,
  Agent extends CloudflareAlarmAgent,
>({
  createAgent,
  defaultPrefix = defaultContextPrefix,
  env,
  readPrefix,
  storage,
}: CloudflareAgentContextOptions<Env, Agent>): CloudflareAgentContext<Agent> {
  const createHost = (prefix = defaultPrefix) =>
    createCloudflareStorageHost({ prefix, storage });
  const createContextAgent = (prefix = defaultPrefix) =>
    createAgent({
      env,
      host: createHost(prefix),
      prefix,
      storage,
    });

  return {
    agent: createContextAgent,
    drainAlarm: async (budget) => {
      const prefix = (await readPrefix?.({ env, storage })) ?? defaultPrefix;
      return await drainCloudflareAlarm({
        agent: createContextAgent(prefix),
        ...budget,
        prefix,
        storage,
      });
    },
    host: createHost,
    storage,
  };
}
