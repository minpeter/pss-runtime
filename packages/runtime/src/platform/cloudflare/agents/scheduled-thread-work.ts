import { isScheduledThreadPrompt } from "../../../execution/scheduled-work";
import type { CloudflareDurableObjectStorage } from "../host/durable-object-host";
import {
  deleteScheduledWork,
  selectScheduledWork,
} from "../host/scheduled-work-table";
import type { CloudflareAgentsFiberPayload } from "./payload";
import { alarmScheduledThreadPromptWorkId } from "./scheduled-work-ids";
import { alarmThreadPromptKind } from "./scheduled-work-kinds";

type CloudflareAgentsThreadFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "thread" }
>;

export async function claimAlarmScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<boolean> {
  if (!hasAlarmScheduledThreadPrompt(storage, payload)) {
    return false;
  }
  await removeAlarmScheduledThreadPrompt(storage, payload);
  return true;
}

export async function removeAlarmScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<void> {
  const workId = alarmScheduledThreadPromptWorkId(payload);
  await Promise.all(
    selectScheduledWork(storage, payload.prefix, alarmThreadPromptKind)
      .filter(
        (row) =>
          row.work_id === workId &&
          matchesScheduledThreadPayload(row.payload, payload)
      )
      .map((row) =>
        deleteScheduledWork(
          storage,
          payload.prefix,
          alarmThreadPromptKind,
          row.work_id
        )
      )
  );
}

export function hasAlarmScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): boolean {
  const workId = alarmScheduledThreadPromptWorkId(payload);
  return selectScheduledWork(
    storage,
    payload.prefix,
    alarmThreadPromptKind
  ).some(
    (row) =>
      row.work_id === workId &&
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
    value.runId === payload.runId
  );
}
