import type {
  CloudflareAgentsFiberPayload,
  CloudflareAgentsThreadFiberPayload,
} from "./payload";

type CloudflareAgentsRunFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "run" }
>;

export function scheduledRunPayloadWorkId(
  payload: CloudflareAgentsRunFiberPayload
): string {
  return [
    payload.runId,
    payload.attempt === undefined ? "" : String(payload.attempt),
  ]
    .map(scheduledWorkIdPart)
    .join("|");
}

export function legacyScheduledRunPayloadWorkId(
  payload: CloudflareAgentsRunFiberPayload
): string {
  return payload.attempt === undefined
    ? payload.runId
    : `${payload.runId}|attempt:${payload.attempt}`;
}

export function scheduledThreadPayloadWorkId(
  payload: CloudflareAgentsThreadFiberPayload
): string {
  return [
    payload.threadKey,
    payload.idempotencyKey ?? "",
    payload.runId,
    payload.notificationId ?? "",
    payload.attempt === undefined ? "" : String(payload.attempt),
  ]
    .map(scheduledWorkIdPart)
    .join("|");
}

export function legacyScheduledThreadPayloadWorkId(
  payload: CloudflareAgentsThreadFiberPayload
): string {
  return [payload.threadKey, payload.idempotencyKey ?? "", payload.runId]
    .map(scheduledWorkIdPart)
    .join("|");
}

function scheduledWorkIdPart(value: string): string {
  return `${value.length}:${value}`;
}
