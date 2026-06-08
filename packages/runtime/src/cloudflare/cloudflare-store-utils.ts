import type { NotificationRecord, RunRecord } from "../execution";
import type { StoredSession } from "../index";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";

export async function withTransaction<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectStorage) => Promise<T>
): Promise<T> {
  return storage.transaction
    ? await storage.transaction(fn)
    : await fn(storage);
}

export async function getRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<RunRecord | null> {
  return (await storage.get<RunRecord>(storeKey(prefix, "run", runId))) ?? null;
}

export async function putRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  record: RunRecord
): Promise<void> {
  await storage.put(storeKey(prefix, "run", record.runId), record);
}

export async function indexRun(
  storage: CloudflareDurableObjectStorage,
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
  storage: CloudflareDurableObjectStorage,
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
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  record: NotificationRecord
): Promise<void> {
  await storage.put(
    storeKey(prefix, "notification", record.idempotencyKey),
    record
  );
}

export async function getSession(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  sessionKey: string
): Promise<StoredSession | null> {
  return (
    (await storage.get<StoredSession>(
      storeKey(prefix, "session", sessionKey)
    )) ?? null
  );
}

export async function putSession(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  sessionKey: string,
  session: StoredSession
): Promise<void> {
  await storage.put(storeKey(prefix, "session", sessionKey), session);
}

export async function readList<T>(
  storage: CloudflareDurableObjectStorage,
  storageKey: string
): Promise<T[]> {
  return ((await storage.get<readonly T[]>(storageKey)) ?? []).map((item) =>
    structuredClone(item)
  );
}

export function storeKey(prefix: string, scope: string, id: string): string {
  return `${prefix}:${scope}:${encodeURIComponent(id)}`;
}
