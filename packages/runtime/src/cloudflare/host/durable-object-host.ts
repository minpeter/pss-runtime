import type { ExecutionHost, ExecutionScheduler } from "../../execution";
import type { SessionStore } from "../../index";
import {
  InMemoryCloudflareDurableObjectStorage as BaseInMemoryCloudflareDurableObjectStorage,
  type CloudflareDurableObjectTransactionStorage,
  type CloudflareDurableObjectStorage as DurableObjectStoragePort,
} from "../storage/durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "../storage/execution/store";

const defaultPrefix = "pss-runtime";

export interface CloudflareScheduledThreadPrompt {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId?: string;
  readonly threadKey: string;
}

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
  storage,
  scheduler = createCloudflareAlarmScheduler({ prefix, storage }),
}: {
  readonly prefix?: string;
  readonly scheduler?: ExecutionScheduler;
  readonly sessionStore?: SessionStore;
  readonly storage: CloudflareDurableObjectStorage;
}): ExecutionHost {
  const store = new DurableObjectExecutionStore({ prefix, storage });
  return {
    kind: "execution",
    scheduler,
    store: sessionStore
      ? executionStoreWithSessions(store, sessionStore)
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
      await appendUnique(storage, scheduledRunsKey(prefix), runId);
      await setAlarm(storage, options?.runAfterMs ?? 0);
    },
    resumeThread: async (threadKey, options) => {
      await appendThreadPrompt(storage, scheduledThreadPromptsKey(prefix), {
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
  options: { readonly prefix?: string } = {}
): Promise<readonly string[]> {
  return await readList<string>(
    storage,
    scheduledRunsKey(options.prefix ?? defaultPrefix)
  );
}

export async function ackScheduledCloudflareRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await removeFromList<string>(
    storage,
    scheduledRunsKey(options.prefix ?? defaultPrefix),
    (scheduledRunId) => scheduledRunId === runId
  );
}

export async function listScheduledCloudflareThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: { readonly prefix?: string } = {}
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  return await readList<CloudflareScheduledThreadPrompt>(
    storage,
    scheduledThreadPromptsKey(options.prefix ?? defaultPrefix)
  );
}

export async function ackScheduledCloudflareThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  await removeFromList<CloudflareScheduledThreadPrompt>(
    storage,
    scheduledThreadPromptsKey(options.prefix ?? defaultPrefix),
    (scheduledPrompt) => threadPromptsMatch(scheduledPrompt, prompt)
  );
}

export async function rescheduleCloudflareAlarm(
  storage: CloudflareDurableObjectStorage,
  options: { readonly runAfterMs?: number } = {}
): Promise<void> {
  await setAlarm(storage, options.runAfterMs ?? 0);
}

async function appendUnique(
  storage: CloudflareDurableObjectStorage,
  key: string,
  value: string
): Promise<void> {
  await withTransaction(storage, async (tx) => {
    const values = await readList<string>(tx, key);
    if (!values.includes(value)) {
      values.push(value);
      await tx.put(key, values);
    }
  });
}

async function appendThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  key: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<void> {
  await withTransaction(storage, async (tx) => {
    const values = await readList<CloudflareScheduledThreadPrompt>(tx, key);
    const isDuplicate = values.some(
      (existing) =>
        existing.threadKey === prompt.threadKey &&
        existing.idempotencyKey === prompt.idempotencyKey &&
        existing.runId === prompt.runId
    );
    if (!isDuplicate) {
      values.push(prompt);
      await tx.put(key, values);
    }
  });
}

async function removeFromList<T>(
  storage: CloudflareDurableObjectStorage,
  key: string,
  shouldRemove: (value: T) => boolean
): Promise<void> {
  await withTransaction(storage, async (tx) => {
    const remaining = (await readList<T>(tx, key)).filter(
      (value) => !shouldRemove(value)
    );
    await tx.put(key, remaining);
  });
}

async function readList<T>(
  storage: CloudflareDurableObjectTransactionStorage,
  key: string
): Promise<T[]> {
  return ((await storage.get<readonly T[]>(key)) ?? []).map((item) =>
    structuredClone(item)
  );
}

async function setAlarm(
  storage: CloudflareDurableObjectStorage,
  runAfterMs: number
): Promise<void> {
  await storage.setAlarm?.(Date.now() + Math.max(0, runAfterMs));
}

async function withTransaction<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectTransactionStorage) => Promise<T>
): Promise<T> {
  return storage.transaction
    ? await storage.transaction(fn)
    : await fn(storage);
}

function scheduledRunsKey(prefix: string): string {
  return `${prefix}:scheduled-runs`;
}

function scheduledThreadPromptsKey(prefix: string): string {
  return `${prefix}:scheduled-session-prompts`;
}

function threadPromptsMatch(
  left: CloudflareScheduledThreadPrompt,
  right: CloudflareScheduledThreadPrompt
): boolean {
  return (
    left.idempotencyKey === right.idempotencyKey &&
    left.notificationId === right.notificationId &&
    left.runId === right.runId &&
    left.threadKey === right.threadKey
  );
}

function executionStoreWithSessions(
  store: ExecutionHost["store"],
  sessions: SessionStore
): ExecutionHost["store"] {
  return {
    checkpoints: store.checkpoints,
    events: store.events,
    notifications: store.notifications,
    runs: store.runs,
    sessions,
    transaction: (fn) =>
      store.transaction((tx) =>
        fn({
          checkpoints: tx.checkpoints,
          events: tx.events,
          notifications: tx.notifications,
          runs: tx.runs,
          sessions,
        })
      ),
  };
}
