import type { ExecutionHost } from "../../execution/host/types";
import type { AgentEvent, UserInput } from "../../session/protocol/events";
import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";

export interface DispatchCloudflareAgentNotificationInput {
  readonly host?: ExecutionHost;
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly namespace: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly prefix?: string;
  readonly sessionKey: string;
  readonly storage: CloudflareDurableObjectStorage;
}
