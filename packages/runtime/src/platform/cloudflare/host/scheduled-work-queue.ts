import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import {
  applyListLimit,
  isDefined,
  isLegacyRunWork,
  isLegacyThreadPromptWork,
  parseScheduledRunPayload,
  parseScheduledThreadPromptPayload,
  runScheduledWorkId,
  threadPromptScheduledWorkId,
} from "./scheduled-work-codec";
import {
  claimScheduledWork,
  deleteScheduledWork,
  insertScheduledWork,
  selectScheduledWork,
} from "./scheduled-work-table";

export interface CloudflareScheduledThreadPrompt {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId?: string;
  readonly threadKey: string;
}

export interface ScheduledWorkListOptions {
  readonly limit?: number;
  readonly prefix?: string;
}

export async function appendScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<void> {
  await appendScheduledRunWork(
    storage,
    prefix,
    runScheduledWorkId(runId),
    runId
  );
}

export async function appendScheduledRunWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string,
  runId: string
): Promise<void> {
  await insertScheduledWork(storage, prefix, "run", workId, runId, {
    runId,
  });
}

export async function appendScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<void> {
  await appendScheduledThreadPromptWork(
    storage,
    prefix,
    threadPromptScheduledWorkId(prompt),
    prompt
  );
}

export async function appendScheduledThreadPromptWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<void> {
  await insertScheduledWork(storage, prefix, "thread-prompt", workId, prompt, {
    runId: prompt.runId,
    threadKey: prompt.threadKey,
  });
}

export function listScheduledRuns(
  storage: CloudflareDurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly string[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    applyListLimit(
      selectScheduledWork(storage, prefix, "run")
        .filter(isLegacyRunWork)
        .map((row) => parseScheduledRunPayload(row.payload))
        .filter(isDefined),
      options.limit
    )
  );
}

export function hasScheduledRunWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string
): boolean {
  return selectScheduledWork(storage, prefix, "run").some(
    (row) => row.work_id === workId
  );
}

export function hasScheduledThreadPromptWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string
): boolean {
  return selectScheduledWork(storage, prefix, "thread-prompt").some(
    (row) => row.work_id === workId
  );
}

export function ackScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<void> {
  const prefix = options.prefix ?? defaultPrefix;
  return ackScheduledRunWork(storage, prefix, runScheduledWorkId(runId));
}

export function ackScheduledRunWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string
): Promise<void> {
  return deleteScheduledWork(storage, prefix, "run", workId);
}

export async function claimScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<boolean> {
  const prefix = options.prefix ?? defaultPrefix;
  return await claimScheduledRunWork(
    storage,
    prefix,
    runScheduledWorkId(runId)
  );
}

export async function claimScheduledRunWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string
): Promise<boolean> {
  return await claimScheduledWork(storage, prefix, "run", workId);
}

export function listScheduledThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    applyListLimit(
      selectScheduledWork(storage, prefix, "thread-prompt")
        .filter(isLegacyThreadPromptWork)
        .map((row) => parseScheduledThreadPromptPayload(row.payload))
        .filter(isDefined),
      options.limit
    )
  );
}

export function ackScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<void> {
  const prefix = options.prefix ?? defaultPrefix;
  return ackScheduledThreadPromptWork(
    storage,
    prefix,
    threadPromptScheduledWorkId(prompt)
  );
}

export function ackScheduledThreadPromptWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string
): Promise<void> {
  return deleteScheduledWork(storage, prefix, "thread-prompt", workId);
}

export async function claimScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<boolean> {
  const prefix = options.prefix ?? defaultPrefix;
  return await claimScheduledThreadPromptWork(
    storage,
    prefix,
    threadPromptScheduledWorkId(prompt)
  );
}

export async function claimScheduledThreadPromptWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  workId: string
): Promise<boolean> {
  return await claimScheduledWork(storage, prefix, "thread-prompt", workId);
}
