import {
  type DispatchedAgentNotification,
  dispatchAgentNotification,
} from "../../execution/dispatch/notification-dispatch";
import { createCloudflareDurableObjectHost } from "../host/durable-object-host";
import type { DispatchCloudflareAgentNotificationInput } from "./notification-dispatch-types";

export function dispatchCloudflareAgentNotification({
  host,
  prefix,
  storage,
  ...input
}: DispatchCloudflareAgentNotificationInput): Promise<DispatchedAgentNotification> {
  return dispatchAgentNotification({
    ...input,
    host: host ?? createCloudflareDurableObjectHost({ prefix, storage }),
  });
}
