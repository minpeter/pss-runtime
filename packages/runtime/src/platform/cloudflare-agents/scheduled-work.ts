import type { CloudflareDurableObjectStorage } from "../cloudflare";
import {
  ackScheduledRunWork,
  ackScheduledThreadPromptWork,
  appendScheduledRunWork,
  appendScheduledThreadPromptWork,
  claimScheduledRunWork,
  claimScheduledThreadPromptWork,
  hasScheduledRunWork,
  hasScheduledThreadPromptWork,
} from "../cloudflare/host/scheduled-work-queue";
import type {
  CloudflareAgentsFiberPayload,
  CloudflareAgentsThreadFiberPayload,
} from "./payload";

export async function mirrorCloudflareAgentsScheduledPayload({
  payload,
  storage,
}: {
  readonly payload: CloudflareAgentsFiberPayload;
  readonly runAfterMs: number;
  readonly storage?: CloudflareDurableObjectStorage;
}): Promise<void> {
  if (storage === undefined) {
    return;
  }
  switch (payload.kind) {
    case "run":
      await appendScheduledRunWork(
        storage,
        payload.prefix,
        scheduledRunPayloadWorkId(payload),
        payload.runId
      );
      return;
    case "thread":
      await appendScheduledThreadPromptWork(
        storage,
        payload.prefix,
        scheduledThreadPayloadWorkId(payload),
        threadPromptForPayload(payload)
      );
      return;
    default:
      return assertNeverPayload(payload);
  }
}

export async function claimCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<boolean> {
  switch (payload.kind) {
    case "run":
      return await claimScheduledRunWork(
        storage,
        payload.prefix,
        scheduledRunPayloadWorkId(payload)
      );
    case "thread":
      return await claimScheduledThreadPromptWork(
        storage,
        payload.prefix,
        scheduledThreadPayloadWorkId(payload)
      );
    default:
      return assertNeverPayload(payload);
  }
}

export async function removeCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<void> {
  switch (payload.kind) {
    case "run":
      await ackScheduledRunWork(
        storage,
        payload.prefix,
        scheduledRunPayloadWorkId(payload)
      );
      return;
    case "thread":
      await ackScheduledThreadPromptWork(
        storage,
        payload.prefix,
        scheduledThreadPayloadWorkId(payload)
      );
      return;
    default:
      return assertNeverPayload(payload);
  }
}

export function hasCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<boolean> {
  switch (payload.kind) {
    case "run":
      return Promise.resolve(
        hasScheduledRunWork(
          storage,
          payload.prefix,
          scheduledRunPayloadWorkId(payload)
        )
      );
    case "thread":
      return Promise.resolve(
        hasScheduledThreadPromptWork(
          storage,
          payload.prefix,
          scheduledThreadPayloadWorkId(payload)
        )
      );
    default:
      return assertNeverPayload(payload);
  }
}

function scheduledRunPayloadWorkId(
  payload: Extract<CloudflareAgentsFiberPayload, { readonly kind: "run" }>
): string {
  return payload.attempt === undefined
    ? payload.runId
    : `${payload.runId}|attempt:${payload.attempt}`;
}

function scheduledThreadPayloadWorkId(
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

function threadPromptForPayload(payload: CloudflareAgentsThreadFiberPayload): {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId?: string;
  readonly threadKey: string;
} {
  return {
    idempotencyKey: payload.idempotencyKey,
    notificationId: payload.notificationId,
    runId: payload.runId,
    threadKey: payload.threadKey,
  };
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}

function scheduledWorkIdPart(value: string): string {
  return `${value.length}:${value}`;
}
