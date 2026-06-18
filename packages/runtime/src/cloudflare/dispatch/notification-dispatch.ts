import {
  type DispatchedAgentNotification,
  dispatchAgentNotification,
} from "../../execution/dispatch/notification-dispatch";
import type { ExecutionHost } from "../../execution/host/types";
import type { AgentEvent, UserInput } from "../../session/protocol/events";
import { createCloudflareDurableObjectHost } from "../host/durable-object-host";
import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";

interface DispatchCloudflareAgentNotificationBase {
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly namespace: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly sessionKey: string;
}

export type DispatchCloudflareAgentNotificationInput =
  | (DispatchCloudflareAgentNotificationBase & {
      readonly host: ExecutionHost;
      readonly prefix?: never;
      readonly storage?: never;
    })
  | (DispatchCloudflareAgentNotificationBase & {
      readonly host?: never;
      readonly prefix?: string;
      readonly storage: CloudflareDurableObjectStorage;
    });

export function dispatchCloudflareAgentNotification({
  host,
  idempotencyKey,
  input,
  namespace,
  observerEvents,
  prefix,
  sessionKey,
  storage,
}: DispatchCloudflareAgentNotificationInput): Promise<DispatchedAgentNotification> {
  return dispatchAgentNotification({
    host:
      host ??
      createCloudflareDurableObjectHost({
        prefix,
        storage,
      }),
    idempotencyKey,
    input,
    namespace,
    observerEvents,
    sessionKey,
  });
}
