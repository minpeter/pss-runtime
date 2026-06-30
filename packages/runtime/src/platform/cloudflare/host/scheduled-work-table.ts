import type { SqlStorage } from "../sql/ports/storage-port";
import {
  type CloudflareDurableObjectStorage,
  type CloudflareDurableObjectTransactionStorage,
  withSqlStorage,
} from "../storage/durable-object/durable-object-storage";

export type ScheduledWorkKind =
  | "agents-run"
  | "agents-thread-prompt"
  | "run"
  | "thread-prompt";

export interface ScheduledWorkRow {
  readonly payload: string;
  readonly run_id?: string | null;
  readonly thread_key?: string | null;
  readonly work_id: string;
}

export interface ScheduledWorkIndexes {
  readonly runId?: string;
  readonly threadKey?: string;
}

export async function insertScheduledWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: unknown,
  indexes: ScheduledWorkIndexes
): Promise<void> {
  await withTransaction(storage, (tx) => {
    insertScheduledWorkRow(
      requiredScheduledWorkSql(tx),
      prefix,
      kind,
      workId,
      payload,
      indexes
    );
    return Promise.resolve();
  });
}

export function selectScheduledWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  limit?: number
): ScheduledWorkRow[] {
  const sql = requiredScheduledWorkSql(storage);
  ensureScheduledWorkSchema(sql);
  if (limit !== undefined) {
    return sql
      .exec<ScheduledWorkRow>(
        "SELECT work_id, payload FROM pss_scheduled_work WHERE prefix = ? AND kind = ? ORDER BY created_at, rowid LIMIT ?",
        prefix,
        kind,
        normalizedListLimit(limit)
      )
      .toArray();
  }
  return sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id, payload FROM pss_scheduled_work WHERE prefix = ? AND kind = ? ORDER BY created_at, rowid",
      prefix,
      kind
    )
    .toArray();
}

export function deleteScheduledWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): Promise<void> {
  deleteScheduledWorkRow(
    requiredScheduledWorkSql(storage),
    prefix,
    kind,
    workId
  );
  return Promise.resolve();
}

export async function claimScheduledWork(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): Promise<boolean> {
  return await withTransaction(storage, (tx) =>
    Promise.resolve(claimScheduledWorkRow(tx, prefix, kind, workId))
  );
}

function insertScheduledWorkRow(
  sql: SqlStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: unknown,
  indexes: ScheduledWorkIndexes
): void {
  ensureScheduledWorkSchema(sql);
  const existing = sql
    .exec(
      "SELECT work_id FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
      prefix,
      kind,
      workId
    )
    .toArray();
  if (existing.length > 0) {
    return;
  }
  sql.exec(
    "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    prefix,
    kind,
    workId,
    JSON.stringify(payload),
    indexes.threadKey ?? null,
    indexes.runId ?? null,
    Date.now()
  );
}

function claimScheduledWorkRow(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): boolean {
  const sql = requiredScheduledWorkSql(storage);
  ensureScheduledWorkSchema(sql);
  const existing = sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
      prefix,
      kind,
      workId
    )
    .toArray();
  if (existing.length === 0) {
    return false;
  }
  deleteScheduledWorkRow(sql, prefix, kind, workId);
  return true;
}

function deleteScheduledWorkRow(
  sql: SqlStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string
): void {
  ensureScheduledWorkSchema(sql);
  sql.exec(
    "DELETE FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
    prefix,
    kind,
    workId
  );
}

function ensureScheduledWorkSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, thread_key TEXT, run_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (prefix, kind, work_id))"
  );
  ensureScheduledWorkColumn(sql, "thread_key");
  ensureScheduledWorkColumn(sql, "run_id");
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_due ON pss_scheduled_work (prefix, kind, created_at, work_id)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_thread ON pss_scheduled_work (prefix, thread_key)"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_run ON pss_scheduled_work (prefix, run_id)"
  );
}

function ensureScheduledWorkColumn(sql: SqlStorage, column: string): void {
  try {
    sql.exec(`ALTER TABLE pss_scheduled_work ADD COLUMN ${column} TEXT`);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

function isDuplicateColumnError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("duplicate column")
  );
}

async function withTransaction<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectTransactionStorage) => Promise<T>
): Promise<T> {
  if (!storage.transaction) {
    return await fn(storage);
  }
  return await storage.transaction(
    async (tx) => await fn(withTransactionSqlStorage(tx, storage.sql))
  );
}

function withTransactionSqlStorage(
  storage: CloudflareDurableObjectTransactionStorage,
  sql: unknown
): CloudflareDurableObjectTransactionStorage {
  return storage.sql === undefined ? withSqlStorage(storage, sql) : storage;
}

function requiredScheduledWorkSql(
  storage: CloudflareDurableObjectTransactionStorage
): SqlStorage {
  const sql = storage.sql;
  if (
    typeof sql === "object" &&
    sql !== null &&
    "exec" in sql &&
    typeof sql.exec === "function"
  ) {
    return sql as SqlStorage;
  }
  throw new Error("Cloudflare scheduled work queue requires SQLite storage.");
}

function normalizedListLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
}
