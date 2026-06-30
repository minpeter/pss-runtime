import type {
  CloudflareDurableObjectStorage,
  CloudflareScheduledThreadPrompt,
} from "../cloudflare/host/durable-object-host";
import {
  appendScheduledRunWork,
  appendScheduledThreadPromptWork,
} from "../cloudflare/host/scheduled-work-queue";
import {
  deleteScheduledWork,
  type ScheduledWorkKind,
  selectScheduledWork,
} from "../cloudflare/host/scheduled-work-table";
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

const defaultPrefix = "pss-runtime";

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
      return await claimScheduledRunPayload(storage, payload);
    case "thread":
      return await claimScheduledThreadPayload(storage, payload);
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
      await removeScheduledRunPayload(storage, payload);
      return;
    case "thread":
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
      return Promise.resolve(hasScheduledRunPayload(storage, payload));
    case "thread":
      return Promise.resolve(hasScheduledThreadPayload(storage, payload));
    default:
      return assertNeverPayload(payload);
  }
}

export async function ackListedCloudflareAgentsScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await deleteMatchingScheduledWork({
    kind: "run",
    matches: (payload) => parseScheduledRunPayload(payload) === runId,
    prefix: options.prefix ?? defaultPrefix,
    storage,
  });
}

export async function ackListedCloudflareAgentsScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await deleteMatchingScheduledWork({
    kind: "thread-prompt",
    matches: (payload) => matchesScheduledThreadPromptPayload(payload, prompt),
    prefix: options.prefix ?? defaultPrefix,
    storage,
  });
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

async function deleteMatchingScheduledWork({
  kind,
  matches,
  prefix,
  storage,
}: {
  readonly kind: ScheduledWorkKind;
  readonly matches: (payload: string) => boolean;
  readonly prefix: string;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  const rows = selectScheduledWork(storage, prefix, kind);
  await Promise.all(
    rows
      .filter((row) => matches(row.payload))
      .map((row) => deleteScheduledWork(storage, prefix, kind, row.work_id))
  );
}

function parseScheduledRunPayload(payload: string): string | undefined {
  const value: unknown = JSON.parse(payload);
  return typeof value === "string" ? value : undefined;
}

function matchesScheduledThreadPromptPayload(
  payload: string,
  prompt: CloudflareScheduledThreadPrompt
): boolean {
  const value: unknown = JSON.parse(payload);
  if (!isScheduledThreadPrompt(value)) {
    return false;
  }
  return (
    value.threadKey === prompt.threadKey &&
    value.idempotencyKey === prompt.idempotencyKey &&
    value.notificationId === prompt.notificationId &&
    value.runId === prompt.runId
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
