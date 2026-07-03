import type { CloudflareDurableObjectStorage } from "../host/durable-object-host";
import {
  deleteScheduledWork,
  selectScheduledWork,
} from "../host/scheduled-work-table";
import type { CloudflareAgentsFiberPayload } from "./payload";
import { alarmScheduledRunWorkId } from "./scheduled-work-ids";
import { alarmRunKind } from "./scheduled-work-kinds";

type CloudflareAgentsRunFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "run" }
>;

export async function claimAlarmScheduledRun(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): Promise<boolean> {
  if (!hasAlarmScheduledRun(storage, payload)) {
    return false;
  }
  await removeAlarmScheduledRun(storage, payload);
  return true;
}

export async function removeAlarmScheduledRun(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): Promise<void> {
  const workId = alarmScheduledRunWorkId(payload);
  await Promise.all(
    selectScheduledWork(storage, payload.prefix, alarmRunKind)
      .filter(
        (row) =>
          row.work_id === workId &&
          parseScheduledRunPayload(row.payload) === payload.runId
      )
      .map((row) =>
        deleteScheduledWork(storage, payload.prefix, alarmRunKind, row.work_id)
      )
  );
}

export function hasAlarmScheduledRun(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): boolean {
  const workId = alarmScheduledRunWorkId(payload);
  return selectScheduledWork(storage, payload.prefix, alarmRunKind).some(
    (row) =>
      row.work_id === workId &&
      parseScheduledRunPayload(row.payload) === payload.runId
  );
}

function parseScheduledRunPayload(payload: string): string | undefined {
  const value: unknown = JSON.parse(payload);
  return typeof value === "string" ? value : undefined;
}
