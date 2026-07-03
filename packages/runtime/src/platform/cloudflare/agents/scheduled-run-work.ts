import type { CloudflareDurableObjectStorage } from "../host/durable-object-host";
import {
  ackScheduledRunWork,
  claimScheduledRunWork,
  hasScheduledRunWork,
} from "../host/scheduled-work-queue";
import {
  deleteScheduledWork,
  selectScheduledWork,
} from "../host/scheduled-work-table";
import type { CloudflareAgentsFiberPayload } from "./payload";
import {
  legacyScheduledRunPayloadWorkId,
  scheduledRunPayloadWorkId,
} from "./scheduled-work-ids";

type CloudflareAgentsRunFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "run" }
>;

export async function claimScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): Promise<boolean> {
  // A row can land in the shared legacy "run" kind under either id format:
  // the plain legacy id, or the current (length-prefixed) one, if it was
  // never mirrored into agentsRunKind. Try the current format first so
  // such rows still resolve here instead of only via agentsRunKind.
  if (
    await claimScheduledRunWork(
      storage,
      payload.prefix,
      scheduledRunPayloadWorkId(payload)
    )
  ) {
    await deleteLegacyScheduledRunPayload(storage, payload);
    return true;
  }
  return await claimLegacyScheduledRunPayload(storage, payload);
}

export async function removeScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): Promise<void> {
  await ackScheduledRunWork(
    storage,
    payload.prefix,
    scheduledRunPayloadWorkId(payload)
  );
  await deleteLegacyScheduledRunPayload(storage, payload);
}

export function hasScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): boolean {
  return (
    hasScheduledRunWork(
      storage,
      payload.prefix,
      scheduledRunPayloadWorkId(payload)
    ) || hasLegacyScheduledRunPayload(storage, payload)
  );
}

async function claimLegacyScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): Promise<boolean> {
  if (!hasLegacyScheduledRunPayload(storage, payload)) {
    return false;
  }
  await deleteLegacyScheduledRunPayload(storage, payload);
  return true;
}

async function deleteLegacyScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): Promise<void> {
  const legacyWorkId = legacyScheduledRunPayloadWorkId(payload);
  await Promise.all(
    selectScheduledWork(storage, payload.prefix, "run")
      .filter(
        (row) =>
          row.work_id === legacyWorkId &&
          parseScheduledRunPayload(row.payload) === payload.runId
      )
      .map((row) =>
        deleteScheduledWork(storage, payload.prefix, "run", row.work_id)
      )
  );
}

function hasLegacyScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): boolean {
  const legacyWorkId = legacyScheduledRunPayloadWorkId(payload);
  return selectScheduledWork(storage, payload.prefix, "run").some(
    (row) =>
      row.work_id === legacyWorkId &&
      parseScheduledRunPayload(row.payload) === payload.runId
  );
}

function parseScheduledRunPayload(payload: string): string | undefined {
  const value: unknown = JSON.parse(payload);
  return typeof value === "string" ? value : undefined;
}
