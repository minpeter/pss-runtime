import {
  type DispatchedAgentNotification,
  dispatchAgentNotification,
  type ExecutionHost,
} from "../../../execution";
import type { AgentEvent, UserInput } from "../../../thread/protocol/events";
import type { CloudflareScheduledThreadPrompt } from "../host/scheduled-work-queue";
import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import {
  type CloudflareAgentsExecutionHostOptions,
  createCloudflareAgentsExecutionHost,
} from "./host";
import {
  ackListedCloudflareAgentsScheduledRun,
  ackListedCloudflareAgentsScheduledThreadPrompt,
  listCloudflareAgentsScheduledRuns,
  listCloudflareAgentsScheduledThreadPrompts,
} from "./scheduled-work-list";
import type { CloudflareAgentsDefaultResumeAgent } from "./types";

export type CloudflareAgentsScheduledThreadPrompt =
  CloudflareScheduledThreadPrompt;

interface DispatchCloudflareAgentsNotificationBase {
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly namespace: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly overlays?: readonly UserInput[];
  readonly threadKey: string;
}

export type DispatchCloudflareAgentsNotificationInput<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = DispatchCloudflareAgentsNotificationBase &
  (
    | {
        readonly host: ExecutionHost;
      }
    | ({ readonly host?: never } & CloudflareAgentsExecutionHostOptions<TAgent>)
  );

export function listScheduledCloudflareAgentsRuns(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly string[]> {
  return listCloudflareAgentsScheduledRuns(storage, options);
}

export function ackScheduledCloudflareAgentsRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  return ackListedCloudflareAgentsScheduledRun(storage, runId, options);
}

export function listScheduledCloudflareAgentsThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly CloudflareAgentsScheduledThreadPrompt[]> {
  return listCloudflareAgentsScheduledThreadPrompts(storage, options);
}

export function ackScheduledCloudflareAgentsThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareAgentsScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  return ackListedCloudflareAgentsScheduledThreadPrompt(
    storage,
    prompt,
    options
  );
}

export function dispatchCloudflareAgentsNotification<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>(
  input: DispatchCloudflareAgentsNotificationInput<TAgent>
): Promise<DispatchedAgentNotification> {
  return dispatchAgentNotification({
    host: dispatchHost(input),
    idempotencyKey: input.idempotencyKey,
    input: input.input,
    namespace: input.namespace,
    observerEvents: input.observerEvents,
    overlays: input.overlays,
    threadKey: input.threadKey,
  });
}

function dispatchHost<TAgent extends CloudflareAgentsDefaultResumeAgent>(
  input: DispatchCloudflareAgentsNotificationInput<TAgent>
): ExecutionHost {
  if ("host" in input && input.host !== undefined) {
    return input.host;
  }
  return createCloudflareAgentsExecutionHost(input);
}
