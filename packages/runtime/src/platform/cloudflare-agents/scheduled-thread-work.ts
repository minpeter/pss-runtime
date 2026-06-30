import type {
  CloudflareDurableObjectStorage,
  CloudflareScheduledThreadPrompt,
} from "../cloudflare/host/durable-object-host";
import {
  ackScheduledThreadPromptWork,
  claimScheduledThreadPromptWork,
  hasScheduledThreadPromptWork,
} from "../cloudflare/host/scheduled-work-queue";
import {
  deleteScheduledWork,
  selectScheduledWork,
} from "../cloudflare/host/scheduled-work-table";
import type { CloudflareAgentsFiberPayload } from "./payload";
import {
  legacyScheduledThreadPayloadWorkId,
  scheduledThreadPayloadWorkId,
} from "./scheduled-work-ids";

type CloudflareAgentsThreadFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "thread" }
>;

export async function claimScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<boolean> {
  if (
    await claimScheduledThreadPromptWork(
      storage,
      payload.prefix,
      scheduledThreadPayloadWorkId(payload)
    )
  ) {
    await deleteLegacyScheduledThreadPayload(storage, payload);
    return true;
  }
  return await claimLegacyScheduledThreadPayload(storage, payload);
}

export async function removeScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<void> {
  await ackScheduledThreadPromptWork(
    storage,
    payload.prefix,
    scheduledThreadPayloadWorkId(payload)
  );
  await deleteLegacyScheduledThreadPayload(storage, payload);
}

export function hasScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): boolean {
  return (
    hasScheduledThreadPromptWork(
      storage,
      payload.prefix,
      scheduledThreadPayloadWorkId(payload)
    ) || hasLegacyScheduledThreadPayload(storage, payload)
  );
}

async function claimLegacyScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<boolean> {
  if (!hasLegacyScheduledThreadPayload(storage, payload)) {
    return false;
  }
  await deleteLegacyScheduledThreadPayload(storage, payload);
  return true;
}

async function deleteLegacyScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<void> {
  const legacyWorkId = legacyScheduledThreadPayloadWorkId(payload);
  await Promise.all(
    selectScheduledWork(storage, payload.prefix, "thread-prompt")
      .filter(
        (row) =>
          row.work_id === legacyWorkId &&
          matchesScheduledThreadPayload(row.payload, payload)
      )
      .map((row) =>
        deleteScheduledWork(
          storage,
          payload.prefix,
          "thread-prompt",
          row.work_id
        )
      )
  );
}

function hasLegacyScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): boolean {
  const legacyWorkId = legacyScheduledThreadPayloadWorkId(payload);
  return selectScheduledWork(storage, payload.prefix, "thread-prompt").some(
    (row) =>
      row.work_id === legacyWorkId &&
      matchesScheduledThreadPayload(row.payload, payload)
  );
}

function matchesScheduledThreadPayload(
  storedPayload: string,
  payload: CloudflareAgentsThreadFiberPayload
): boolean {
  const value: unknown = JSON.parse(storedPayload);
  if (!isScheduledThreadPrompt(value)) {
    return false;
  }
  return (
    value.threadKey === payload.threadKey &&
    value.idempotencyKey === payload.idempotencyKey &&
    value.notificationId === payload.notificationId &&
    value.runId === payload.runId
  );
}

function isScheduledThreadPrompt(
  value: unknown
): value is CloudflareScheduledThreadPrompt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("threadKey" in value) || typeof value.threadKey !== "string") {
    return false;
  }
  if ("idempotencyKey" in value && typeof value.idempotencyKey !== "string") {
    return false;
  }
  if ("notificationId" in value && typeof value.notificationId !== "string") {
    return false;
  }
  if ("runId" in value && typeof value.runId !== "string") {
    return false;
  }
  return true;
}
