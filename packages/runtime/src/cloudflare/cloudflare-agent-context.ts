import type { ExecutionHost } from "../execution";
import type {
  CloudflareAlarmAgent,
  CloudflareAlarmDrainSummary,
} from "./cloudflare-alarm-drainer";
import { drainCloudflareAlarm } from "./cloudflare-alarm-drainer";
import {
  type CloudflareDurableObjectStorage,
  createCloudflareDurableObjectHost,
} from "./cloudflare-host";

const defaultContextPrefix = "pss-runtime";

type MaybePromise<T> = Promise<T> | T;

export interface CloudflareAgentContextFactoryOptions<Env> {
  readonly env: Env;
  readonly host: ExecutionHost;
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
  drainAlarm(): Promise<CloudflareAlarmDrainSummary>;
  host(prefix?: string): ExecutionHost;
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
    createCloudflareDurableObjectHost({ prefix, storage });
  const createContextAgent = (prefix = defaultPrefix) =>
    createAgent({
      env,
      host: createHost(prefix),
      prefix,
      storage,
    });

  return {
    agent: createContextAgent,
    drainAlarm: async () => {
      const prefix = (await readPrefix?.({ env, storage })) ?? defaultPrefix;
      return await drainCloudflareAlarm({
        agent: createContextAgent(prefix),
        prefix,
        storage,
      });
    },
    host: createHost,
    storage,
  };
}
