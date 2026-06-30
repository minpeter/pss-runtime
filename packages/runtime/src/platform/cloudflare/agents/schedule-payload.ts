import type { CloudflareAgentsFiberPayload } from "./payload";

export type CloudflareAgentsDelayedSchedulePayload =
  CloudflareAgentsFiberPayload & {
    readonly scheduleDelaySeconds: number;
  };

export function cloudflareAgentsDelayedSchedulePayload(
  payload: CloudflareAgentsFiberPayload,
  delaySeconds: number
): CloudflareAgentsDelayedSchedulePayload {
  return {
    ...payload,
    scheduleDelaySeconds: delaySeconds,
  };
}
