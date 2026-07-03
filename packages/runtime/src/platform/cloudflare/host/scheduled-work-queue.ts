import {
  applyListLimit,
  isDefined,
  type ScheduledThreadPrompt,
  threadPromptScheduledWorkId,
} from "../../../execution/scheduled-work";
import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import {
  isCanonicalRunWork,
  isCanonicalThreadPromptWork,
  parseScheduledRunPayload,
  parseScheduledThreadPromptPayload,
  runScheduledWorkId,
} from "./scheduled-work-codec";
import {
  claimScheduledWork,
  deleteScheduledWork,
  insertScheduledWork,
  selectScheduledWork,
} from "./scheduled-work-table";

export type CloudflareScheduledThreadPrompt = ScheduledThreadPrompt;

export interface ScheduledWorkListOptions {
  readonly limit?: number;
  readonly prefix?: string;
}

export async function appendScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<void> {
  await insertScheduledWork(
    storage,
    prefix,
    "run",
    runScheduledWorkId(runId),
    runId,
    { runId }
  );
}

export async function appendScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<void> {
  await insertScheduledWork(
    storage,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt),
    prompt,
    { runId: prompt.runId, threadKey: prompt.threadKey }
  );
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
        .filter(isCanonicalRunWork)
        .map((row) => parseScheduledRunPayload(row.payload))
        .filter(isDefined),
      options.limit
    )
  );
}

export function ackScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<void> {
  const prefix = options.prefix ?? defaultPrefix;
  return deleteScheduledWork(storage, prefix, "run", runScheduledWorkId(runId));
}

export async function claimScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<boolean> {
  const prefix = options.prefix ?? defaultPrefix;
  return await claimScheduledWork(
    storage,
    prefix,
    "run",
    runScheduledWorkId(runId)
  );
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
        .filter(isCanonicalThreadPromptWork)
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
  return deleteScheduledWork(
    storage,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt)
  );
}

export async function claimScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<boolean> {
  const prefix = options.prefix ?? defaultPrefix;
  return await claimScheduledWork(
    storage,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt)
  );
}
