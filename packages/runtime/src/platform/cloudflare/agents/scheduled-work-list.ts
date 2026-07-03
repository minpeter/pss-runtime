import { isDefined } from "../../../execution/scheduled-work";
import type {
  CloudflareDurableObjectStorage,
  CloudflareScheduledThreadPrompt,
} from "../host/durable-object-host";
import {
  parseScheduledRunPayload,
  parseScheduledThreadPromptPayload,
} from "../host/scheduled-work-codec";
import {
  deleteScheduledWork,
  type ScheduledWorkKind,
  selectScheduledWork,
} from "../host/scheduled-work-table";
import {
  agentsRunKind,
  agentsThreadPromptKind,
  legacyRunKind,
  legacyThreadPromptKind,
} from "./scheduled-work-kinds";

const defaultPrefix = "pss-runtime";

export function listCloudflareAgentsScheduledRuns(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly string[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    selectScheduledWorkByKinds(
      storage,
      prefix,
      [agentsRunKind, legacyRunKind],
      {
        limit: options.limit,
      }
    )
      .map((row) => parseScheduledRunPayload(row.payload))
      .filter(isDefined)
  );
}

export function listCloudflareAgentsScheduledThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    selectScheduledWorkByKinds(
      storage,
      prefix,
      [agentsThreadPromptKind, legacyThreadPromptKind],
      { limit: options.limit }
    )
      .map((row) => parseScheduledThreadPromptPayload(row.payload))
      .filter(isDefined)
  );
}

export async function ackListedCloudflareAgentsScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await deleteMatchingScheduledWorkKinds({
    kinds: [agentsRunKind, legacyRunKind],
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
  await deleteMatchingScheduledWorkKinds({
    kinds: [agentsThreadPromptKind, legacyThreadPromptKind],
    matches: (payload) => {
      const value = parseScheduledThreadPromptPayload(payload);
      return (
        value !== undefined &&
        value.threadKey === prompt.threadKey &&
        value.idempotencyKey === prompt.idempotencyKey &&
        value.notificationId === prompt.notificationId &&
        value.runId === prompt.runId
      );
    },
    prefix: options.prefix ?? defaultPrefix,
    storage,
  });
}

async function deleteMatchingScheduledWorkKinds({
  kinds,
  matches,
  prefix,
  storage,
}: {
  readonly kinds: readonly ScheduledWorkKind[];
  readonly matches: (payload: string) => boolean;
  readonly prefix: string;
  readonly storage: CloudflareDurableObjectStorage;
}): Promise<void> {
  await Promise.all(
    kinds.flatMap((kind) =>
      selectScheduledWork(storage, prefix, kind)
        .filter((row) => matches(row.payload))
        .map((row) => deleteScheduledWork(storage, prefix, kind, row.work_id))
    )
  );
}

function selectScheduledWorkByKinds(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kinds: readonly ScheduledWorkKind[],
  options: { readonly limit?: number }
): ReturnType<typeof selectScheduledWork> {
  const rows: ReturnType<typeof selectScheduledWork> = [];
  for (const kind of kinds) {
    const remaining = remainingListLimit(options.limit, rows.length);
    if (remaining === 0) {
      break;
    }
    rows.push(...selectScheduledWork(storage, prefix, kind, remaining));
  }
  return rows;
}

function remainingListLimit(
  limit: number | undefined,
  count: number
): number | undefined {
  if (limit === undefined) {
    return;
  }
  return Math.max(0, Math.floor(limit) - count);
}
