import {
  type DispatchedAgentNotification,
  dispatchAgentNotification,
  type ExecutionHost,
} from "../../execution";
import type { AgentEvent, UserInput } from "../../thread/protocol/events";
import {
  type CloudflareDurableObjectStorage,
  type CloudflareScheduledThreadPrompt,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
  type SourceCloudflareAgentNotificationIdempotencyKeyInput,
  sourceCloudflareAgentNotificationIdempotencyKey,
} from "../cloudflare";
import {
  type CloudflareAgentsExecutionHostOptions,
  createCloudflareAgentsExecutionHost,
} from "./host";
import {
  ackListedCloudflareAgentsScheduledRun,
  ackListedCloudflareAgentsScheduledThreadPrompt,
} from "./scheduled-work";
import type { CloudflareAgentsDefaultResumeAgent } from "./types";

export type CloudflareAgentsScheduledThreadPrompt =
  CloudflareScheduledThreadPrompt;
export type SourceCloudflareAgentsNotificationIdempotencyKeyInput =
  SourceCloudflareAgentNotificationIdempotencyKeyInput;

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
  return listScheduledCloudflareRuns(storage, options);
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
  return listScheduledCloudflareThreadPrompts(storage, options);
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

export function rescheduleCloudflareAgentsSchedule(
  _storage: CloudflareDurableObjectStorage,
  _options: { readonly runAfterMs?: number } = {}
): Promise<void> {
  return Promise.resolve();
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

export function sourceCloudflareAgentsNotificationIdempotencyKey(
  input: SourceCloudflareAgentsNotificationIdempotencyKeyInput
): string | undefined {
  return sourceCloudflareAgentNotificationIdempotencyKey(input);
}

function dispatchHost<TAgent extends CloudflareAgentsDefaultResumeAgent>(
  input: DispatchCloudflareAgentsNotificationInput<TAgent>
): ExecutionHost {
  if ("host" in input && input.host !== undefined) {
    return input.host;
  }
  return createCloudflareAgentsExecutionHost(input);
}
