import type { ExecutionHost, ExecutionScheduler } from "../../execution";
import type { ThreadStore } from "../../index";
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
  prefix = defaultPrefix,
  sessionStore,
  threadStore,
  storage,
  scheduler = createCloudflareAlarmScheduler({ prefix, storage }),
}: {
  readonly prefix?: string;
  readonly scheduler?: ExecutionScheduler;
  /** @deprecated Use threadStore. */
  readonly sessionStore?: ThreadStore;
  readonly threadStore?: ThreadStore;
  readonly storage: CloudflareDurableObjectStorage;
}): ExecutionHost {
  const store = new DurableObjectExecutionStore({ prefix, storage });
  const customThreadStore = threadStore ?? sessionStore;
  return {
    kind: "execution",
    scheduler,
    store: customThreadStore
      ? executionStoreWithThreads(store, customThreadStore)
      : store,
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
    checkpoints: store.checkpoints,
    events: store.events,
    notifications: store.notifications,
    runs: store.runs,
    sessions: threads,
    threads,
    transaction: (fn) =>
      store.transaction((tx) =>
        fn({
          checkpoints: tx.checkpoints,
          events: tx.events,
          notifications: tx.notifications,
          runs: tx.runs,
          sessions: threads,
          threads,
        })
      ),
  };
}
