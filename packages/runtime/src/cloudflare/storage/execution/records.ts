import type { NotificationRecord, RunRecord } from "../../../execution";
import type {
  CloudflareDurableObjectStorage,
  CloudflareDurableObjectTransactionStorage,
} from "../durable-object/durable-object-storage";
import {
  assertJsonPayloadWithinBudget,
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";

export async function withTransaction<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectTransactionStorage) => Promise<T>
): Promise<T> {
  return storage.transaction
    ? await storage.transaction(fn)
    : await fn(storage);
}

export async function getRun(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  runId: string
): Promise<RunRecord | null> {
  return (await storage.get<RunRecord>(storeKey(prefix, "run", runId))) ?? null;
}

export async function putRun(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  record: RunRecord,
  options: StoragePayloadBudgetOptions = {}
): Promise<void> {
  assertJsonPayloadWithinBudget(
    "run-record",
    record,
    resolveStoragePayloadMaxBytes(options)
  );
  await storage.put(storeKey(prefix, "run", record.runId), record);
}

export async function indexRun(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  record: RunRecord
): Promise<void> {
  if (record.dedupeKey) {
    await storage.put(
      storeKey(prefix, "run-dedupe", record.dedupeKey),
      record.runId
    );
  }
  if (record.parentRunId) {
    const parentKey = storeKey(prefix, "run-parent", record.parentRunId);
    const runIds = await readList<string>(storage, parentKey);
    if (!runIds.includes(record.runId)) {
      runIds.push(record.runId);
      await storage.put(parentKey, runIds);
    }
  }
}

export async function getNotification(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  idempotencyKey: string
): Promise<NotificationRecord | null> {
  return (
    (await storage.get<NotificationRecord>(
      storeKey(prefix, "notification", idempotencyKey)
    )) ?? null
  );
}

export async function putNotification(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  record: NotificationRecord,
  options: StoragePayloadBudgetOptions = {}
): Promise<void> {
  assertJsonPayloadWithinBudget(
    "notification-record",
    record,
    resolveStoragePayloadMaxBytes(options)
  );
  await storage.put(
    storeKey(prefix, "notification", record.idempotencyKey),
    record
  );
}

export async function readList<T>(
  storage: CloudflareDurableObjectTransactionStorage,
  storageKey: string
): Promise<T[]> {
  return ((await storage.get<readonly T[]>(storageKey)) ?? []).map((item) =>
    structuredClone(item)
  );
}

export function storeKey(prefix: string, kind: string, id: string): string {
  return `${prefix}:${kind}:${id}`;
}
