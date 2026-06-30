import type { CloudflareDurableObjectStorage } from "../host/durable-object-host";
import {
  claimScheduledWork,
  deleteScheduledWork,
  insertScheduledWork,
  type ScheduledWorkKind,
  selectScheduledWork,
} from "../host/scheduled-work-table";
import type {
  CloudflareAgentsFiberPayload,
  CloudflareAgentsThreadFiberPayload,
} from "./payload";
import {
  claimScheduledRunPayload,
  hasScheduledRunPayload,
  removeScheduledRunPayload,
} from "./scheduled-run-work";
import {
  claimScheduledThreadPayload,
  hasScheduledThreadPayload,
  removeScheduledThreadPayload,
} from "./scheduled-thread-work";
import {
  scheduledRunPayloadWorkId,
  scheduledThreadPayloadWorkId,
} from "./scheduled-work-ids";
import { agentsRunKind, agentsThreadPromptKind } from "./scheduled-work-kinds";

type CloudflareAgentsRunFiberPayload = Extract<
  CloudflareAgentsFiberPayload,
  { readonly kind: "run" }
>;

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
      await insertScheduledWork(
        storage,
        payload.prefix,
        agentsRunKind,
        scheduledRunPayloadWorkId(payload),
        payload.runId,
        { runId: payload.runId }
      );
      return;
    case "thread":
      await insertScheduledWork(
        storage,
        payload.prefix,
        agentsThreadPromptKind,
        scheduledThreadPayloadWorkId(payload),
        threadPromptForPayload(payload),
        { runId: payload.runId, threadKey: payload.threadKey }
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
      return await claimCloudflareAgentsScheduledRunPayload(storage, payload);
    case "thread":
      return await claimCloudflareAgentsScheduledThreadPayload(
        storage,
        payload
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
      await deleteScheduledWork(
        storage,
        payload.prefix,
        agentsRunKind,
        scheduledRunPayloadWorkId(payload)
      );
      await removeScheduledRunPayload(storage, payload);
      return;
    case "thread":
      await deleteScheduledWork(
        storage,
        payload.prefix,
        agentsThreadPromptKind,
        scheduledThreadPayloadWorkId(payload)
      );
      await removeScheduledThreadPayload(storage, payload);
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
        hasCloudflareAgentsScheduledRunPayload(storage, payload)
      );
    case "thread":
      return Promise.resolve(
        hasCloudflareAgentsScheduledThreadPayload(storage, payload)
      );
    default:
      return assertNeverPayload(payload);
  }
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

async function claimCloudflareAgentsScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): Promise<boolean> {
  if (
    await claimScheduledWork(
      storage,
      payload.prefix,
      agentsRunKind,
      scheduledRunPayloadWorkId(payload)
    )
  ) {
    await removeScheduledRunPayload(storage, payload);
    return true;
  }
  return await claimScheduledRunPayload(storage, payload);
}

async function claimCloudflareAgentsScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<boolean> {
  if (
    await claimScheduledWork(
      storage,
      payload.prefix,
      agentsThreadPromptKind,
      scheduledThreadPayloadWorkId(payload)
    )
  ) {
    await removeScheduledThreadPayload(storage, payload);
    return true;
  }
  return await claimScheduledThreadPayload(storage, payload);
}

function hasCloudflareAgentsScheduledRunPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsRunFiberPayload
): boolean {
  return (
    hasScheduledWork(
      storage,
      payload.prefix,
      agentsRunKind,
      scheduledRunPayloadWorkId(payload)
    ) || hasScheduledRunPayload(storage, payload)
  );
}

function hasCloudflareAgentsScheduledThreadPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): boolean {
  return (
    hasScheduledWork(
      storage,
      payload.prefix,
      agentsThreadPromptKind,
      scheduledThreadPayloadWorkId(payload)
    ) || hasScheduledThreadPayload(storage, payload)
  );
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}

function hasScheduledWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): boolean {
  return selectScheduledWork(storage, prefix, kind).some(
    (row) => row.work_id === workId
  );
}
