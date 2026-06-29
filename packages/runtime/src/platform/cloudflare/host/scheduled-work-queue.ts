import type { SqlStorage } from "../sql/ports/storage-port";
import {
  type CloudflareDurableObjectStorage,
  type CloudflareDurableObjectTransactionStorage,
  withSqlStorage,
} from "../storage/durable-object/durable-object-storage";

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

type ScheduledWorkKind = "run" | "thread-prompt";

interface ScheduledWorkRow {
  readonly payload: string;
  readonly run_id?: string | null;
  readonly thread_key?: string | null;
  readonly work_id: string;
}

interface ScheduledWorkIndexes {
  readonly runId?: string;
  readonly threadKey?: string;
}

export async function appendScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<void> {
  await withTransaction(storage, (tx) => {
    const sql = requiredScheduledWorkSql(tx);
    insertScheduledWork(sql, prefix, "run", runScheduledWorkId(runId), runId, {
      runId,
    });
    return Promise.resolve();
  });
}

export async function appendScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<void> {
  await withTransaction(storage, (tx) => {
    const sql = requiredScheduledWorkSql(tx);
    insertScheduledWork(
      sql,
      prefix,
      "thread-prompt",
      threadPromptScheduledWorkId(prompt),
      prompt,
      {
        runId: prompt.runId,
        threadKey: prompt.threadKey,
      }
    );
    return Promise.resolve();
  });
}

export function listScheduledRuns(
  storage: CloudflareDurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly string[]> {
  const prefix = options.prefix ?? defaultPrefix;
  const sql = requiredScheduledWorkSql(storage);
  return Promise.resolve(
    selectScheduledWork(sql, prefix, "run", options.limit).map(
      (row) => JSON.parse(row.payload) as string
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
  const sql = requiredScheduledWorkSql(storage);
  deleteScheduledWork(sql, prefix, "run", runScheduledWorkId(runId));
  return Promise.resolve();
}

export function listScheduledThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  const prefix = options.prefix ?? defaultPrefix;
  const sql = requiredScheduledWorkSql(storage);
  return Promise.resolve(
    selectScheduledWork(sql, prefix, "thread-prompt", options.limit).map(
      (row) => JSON.parse(row.payload) as CloudflareScheduledThreadPrompt
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
  const sql = requiredScheduledWorkSql(storage);
  deleteScheduledWork(
    sql,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt)
  );
  return Promise.resolve();
}

function insertScheduledWork(
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

function selectScheduledWork(
  sql: SqlStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  limit?: number
): ScheduledWorkRow[] {
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

function deleteScheduledWork(
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

function runScheduledWorkId(runId: string): string {
  return runId;
}

function threadPromptScheduledWorkId(
  prompt: CloudflareScheduledThreadPrompt
): string {
  return [prompt.threadKey, prompt.idempotencyKey ?? "", prompt.runId ?? ""]
    .map(scheduledWorkIdPart)
    .join("|");
}

function normalizedListLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
}

function scheduledWorkIdPart(value: string): string {
  return `${value.length}:${value}`;
}
