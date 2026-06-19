import type { NotificationRecord } from "../../../execution";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { CloudflareDurableObjectTransactionStorage } from "../durable-object/durable-object-storage";
import {
  assertJsonPayloadWithinBudget,
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { storeKey } from "./records";

interface NotificationRow {
  readonly record: string;
}

export async function getNotification(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  idempotencyKey: string
): Promise<NotificationRecord | null> {
  const sql = sqlStorage(storage);
  if (sql) {
    const row = selectNotificationRow(sql, prefix, idempotencyKey);
    if (row) {
      return parseNotificationRecord(row);
    }
  }

  const legacy =
    (await storage.get<NotificationRecord>(
      storeKey(prefix, "notification", idempotencyKey)
    )) ?? null;
  if (legacy && sql) {
    await putNotification(storage, prefix, legacy);
  }
  return legacy;
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
  const sql = sqlStorage(storage);
  const key = storeKey(prefix, "notification", record.idempotencyKey);
  if (sql) {
    putSqlNotification(sql, prefix, record);
    await storage.delete(key);
    return;
  }
  await storage.put(key, record);
}

function selectNotificationRow(
  sql: SqlStorage,
  prefix: string,
  idempotencyKey: string
): NotificationRow | undefined {
  ensureNotificationSchema(sql);
  return sql
    .exec<NotificationRow>(
      "SELECT record FROM pss_notification WHERE prefix = ? AND idempotency_key = ? LIMIT 1",
      prefix,
      idempotencyKey
    )
    .toArray()[0];
}

function parseNotificationRecord(row: NotificationRow): NotificationRecord {
  return JSON.parse(row.record) as NotificationRecord;
}

function sqlStorage(
  storage: CloudflareDurableObjectTransactionStorage
): SqlStorage | undefined {
  const sql = storage.sql;
  return isSqlStorage(sql) ? sql : undefined;
}

function isSqlStorage(value: unknown): value is SqlStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    "exec" in value &&
    typeof value.exec === "function"
  );
}

function ensureNotificationSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_notification (prefix TEXT NOT NULL, idempotency_key TEXT NOT NULL, record TEXT NOT NULL, notification_id TEXT NOT NULL, run_id TEXT NOT NULL, thread_key TEXT NOT NULL, owner_namespace TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (prefix, idempotency_key))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_notification_status ON pss_notification (prefix, status, created_at)"
  );
}

function putSqlNotification(
  sql: SqlStorage,
  prefix: string,
  record: NotificationRecord
): void {
  ensureNotificationSchema(sql);
  const nowMs = Date.now();
  sql.exec(
    "INSERT INTO pss_notification (prefix, idempotency_key, record, notification_id, run_id, thread_key, owner_namespace, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(prefix, idempotency_key) DO UPDATE SET record = excluded.record, notification_id = excluded.notification_id, run_id = excluded.run_id, thread_key = excluded.thread_key, owner_namespace = excluded.owner_namespace, status = excluded.status, updated_at = excluded.updated_at",
    prefix,
    record.idempotencyKey,
    JSON.stringify(record),
    record.notificationId,
    record.runId,
    record.threadKey,
    record.ownerNamespace ?? null,
    record.status,
    nowMs,
    nowMs
  );
}
