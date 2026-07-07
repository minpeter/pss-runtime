import type { ExecutionHost, ExecutionScheduler } from "../../../execution";
import type { ThreadStore } from "../../../index";
import {
  InMemoryCloudflareDurableObjectStorage as BaseInMemoryCloudflareDurableObjectStorage,
  type CloudflareDurableObjectStorage as DurableObjectStoragePort,
} from "../storage/durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "../storage/execution/store";
import type { CloudflareScheduledThreadPrompt } from "./scheduled-work-queue";
import {
  ackScheduledRun,
  ackScheduledThreadPrompt,
  appendScheduledRun,
  appendScheduledThreadPrompt,
  claimScheduledRun,
  claimScheduledThreadPrompt,
  listScheduledRuns,
  listScheduledThreadPrompts,
} from "./scheduled-work-queue";

const defaultPrefix = "pss-runtime";

export type { CloudflareScheduledThreadPrompt } from "./scheduled-work-queue";

export type CloudflareDurableObjectStorage = DurableObjectStoragePort;

export type CloudflareDurableObjectId = unknown;

export interface CloudflareDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareDurableObjectNamespace<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
> {
  get(id: CloudflareDurableObjectId): Stub;
  idFromName(name: string): CloudflareDurableObjectId;
}

export interface CloudflareDurableObjectState {
  readonly storage: CloudflareDurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

export class InMemoryCloudflareDurableObjectStorage extends BaseInMemoryCloudflareDurableObjectStorage {}

export function createCloudflareDurableObjectHost({
  maxPayloadBytes,
  prefix = defaultPrefix,
  threadStore,
  storage,
  scheduler = createCloudflareAlarmScheduler({ prefix, storage }),
}: {
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly scheduler?: ExecutionScheduler;
  readonly threadStore?: ThreadStore;
  readonly storage: CloudflareDurableObjectStorage;
}): ExecutionHost {
  const store = new DurableObjectExecutionStore({
    maxPayloadBytes,
    prefix,
    storage,
  });
  return {
    kind: "execution",
    scheduler,
    store: threadStore ? executionStoreWithThreads(store, threadStore) : store,
  };
}

export function createCloudflareAlarmScheduler({
  prefix = defaultPrefix,
  storage,
}: {
  readonly prefix?: string;
  readonly storage: CloudflareDurableObjectStorage;
}): ExecutionScheduler {
  return {
    enqueueRun: async (runId, options) => {
      await appendScheduledRun(storage, prefix, runId);
      await setAlarm(storage, options?.runAfterMs ?? 0);
    },
    resumeThread: async (threadKey, options) => {
      await appendScheduledThreadPrompt(storage, prefix, {
        idempotencyKey: options?.idempotencyKey,
        notificationId: options?.notificationId,
        runId: options?.runId,
        threadKey,
      });
      await setAlarm(storage, 0);
    },
  };
}

export async function listScheduledCloudflareRuns(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly string[]> {
  return await listScheduledRuns(storage, options, defaultPrefix);
}

export async function ackScheduledCloudflareRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await ackScheduledRun(storage, runId, options, defaultPrefix);
}

export async function claimScheduledCloudflareRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<boolean> {
  return await claimScheduledRun(storage, runId, options, defaultPrefix);
}

export async function listScheduledCloudflareThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: { readonly limit?: number; readonly prefix?: string } = {}
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  return await listScheduledThreadPrompts(storage, options, defaultPrefix);
}

export async function ackScheduledCloudflareThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await ackScheduledThreadPrompt(storage, prompt, options, defaultPrefix);
}

export async function claimScheduledCloudflareThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<boolean> {
  return await claimScheduledThreadPrompt(
    storage,
    prompt,
    options,
    defaultPrefix
  );
}

export async function rescheduleCloudflareAlarm(
  storage: CloudflareDurableObjectStorage,
  options: { readonly runAfterMs?: number } = {}
): Promise<void> {
  await setAlarm(storage, options.runAfterMs ?? 0);
}

async function setAlarm(
  storage: CloudflareDurableObjectStorage,
  runAfterMs: number
): Promise<void> {
  await storage.setAlarm?.(Date.now() + Math.max(0, runAfterMs));
}

function executionStoreWithThreads(
  store: ExecutionHost["store"],
  threads: ThreadStore
): ExecutionHost["store"] {
  return {
    events: store.events,
    inputs: store.inputs,
    notifications: store.notifications,
    checkpoints: store.checkpoints,
    threads,
    turns: store.turns,
    transaction: (fn) =>
      store.transaction((tx) =>
        fn({
          events: tx.events,
          inputs: tx.inputs,
          notifications: tx.notifications,
          checkpoints: tx.checkpoints,
          threads,
          turns: tx.turns,
        })
      ),
  };
}
