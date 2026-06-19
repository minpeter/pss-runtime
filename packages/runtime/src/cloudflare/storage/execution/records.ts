import type { NotificationRecord } from "../../../execution";
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
