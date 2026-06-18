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
  readonly work_id: string;
}

export async function appendScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<void> {
  await withTransaction(storage, async (tx) => {
    const sql = scheduledWorkSql(tx);
    if (!sql) {
      await appendUniqueLegacy(tx, scheduledRunsKey(prefix), runId);
      return;
    }
    await migrateLegacyScheduledWork(tx, prefix);
    insertScheduledWork(sql, prefix, "run", runScheduledWorkId(runId), runId);
  });
}

export async function appendScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<void> {
  await withTransaction(storage, async (tx) => {
    const sql = scheduledWorkSql(tx);
    if (!sql) {
      await appendThreadPromptLegacy(
        tx,
        scheduledThreadPromptsKey(prefix),
        prompt
      );
      return;
    }
    await migrateLegacyScheduledWork(tx, prefix);
    insertScheduledWork(
      sql,
      prefix,
      "thread-prompt",
      threadPromptScheduledWorkId(prompt),
      prompt
    );
  });
}

export async function listScheduledRuns(
  storage: CloudflareDurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly string[]> {
  const prefix = options.prefix ?? defaultPrefix;
  const sql = scheduledWorkSql(storage);
  if (!sql) {
    return await readLegacyList<string>(
      storage,
      scheduledRunsKey(prefix),
      options.limit
    );
  }

  await migrateLegacyScheduledWork(storage, prefix);
  return selectScheduledWork(sql, prefix, "run", options.limit).map(
    (row) => JSON.parse(row.payload) as string
  );
}

export async function ackScheduledRun(
  storage: CloudflareDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<void> {
  const prefix = options.prefix ?? defaultPrefix;
  const sql = scheduledWorkSql(storage);
  if (!sql) {
    await removeFromLegacyList<string>(
      storage,
      scheduledRunsKey(prefix),
      (scheduledRunId) => scheduledRunId === runId
    );
    return;
  }

  await migrateLegacyScheduledWork(storage, prefix);
  deleteScheduledWork(sql, prefix, "run", runScheduledWorkId(runId));
}

export async function listScheduledThreadPrompts(
  storage: CloudflareDurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly CloudflareScheduledThreadPrompt[]> {
  const prefix = options.prefix ?? defaultPrefix;
  const sql = scheduledWorkSql(storage);
  if (!sql) {
    return await readLegacyList<CloudflareScheduledThreadPrompt>(
      storage,
      scheduledThreadPromptsKey(prefix),
      options.limit
    );
  }

  await migrateLegacyScheduledWork(storage, prefix);
  return selectScheduledWork(sql, prefix, "thread-prompt", options.limit).map(
    (row) => JSON.parse(row.payload) as CloudflareScheduledThreadPrompt
  );
}

export async function ackScheduledThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  prompt: CloudflareScheduledThreadPrompt,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<void> {
  const prefix = options.prefix ?? defaultPrefix;
  const sql = scheduledWorkSql(storage);
  if (!sql) {
    await removeFromLegacyList<CloudflareScheduledThreadPrompt>(
      storage,
      scheduledThreadPromptsKey(prefix),
      (scheduledPrompt) => threadPromptsMatch(scheduledPrompt, prompt)
    );
    return;
  }

  await migrateLegacyScheduledWork(storage, prefix);
  deleteScheduledWork(
    sql,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt)
  );
}

async function migrateLegacyScheduledWork(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string
): Promise<void> {
  const sql = scheduledWorkSql(storage);
  if (!sql) {
    return;
  }

  const legacyRuns =
    (await storage.get<readonly string[]>(scheduledRunsKey(prefix))) ?? [];
  const legacyPrompts =
    (await storage.get<readonly CloudflareScheduledThreadPrompt[]>(
      scheduledThreadPromptsKey(prefix)
    )) ?? [];

  if (legacyRuns.length === 0 && legacyPrompts.length === 0) {
    ensureScheduledWorkSchema(sql);
    return;
  }

  for (const runId of legacyRuns) {
    insertScheduledWork(sql, prefix, "run", runScheduledWorkId(runId), runId);
  }
  for (const prompt of legacyPrompts) {
    insertScheduledWork(
      sql,
      prefix,
      "thread-prompt",
      threadPromptScheduledWorkId(prompt),
      prompt
    );
  }
  await storage.delete(scheduledRunsKey(prefix));
  await storage.delete(scheduledThreadPromptsKey(prefix));
}

function insertScheduledWork(
  sql: SqlStorage,
  prefix: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: unknown
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
    "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    prefix,
    kind,
    workId,
    JSON.stringify(payload),
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
    "CREATE TABLE IF NOT EXISTS pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (prefix, kind, work_id))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_scheduled_work_due ON pss_scheduled_work (prefix, kind, created_at, work_id)"
  );
}

async function appendUniqueLegacy<T>(
  storage: CloudflareDurableObjectTransactionStorage,
  key: string,
  value: T
): Promise<void> {
  const values = await readLegacyList<T>(storage, key);
  if (!values.includes(value)) {
    values.push(value);
    await storage.put(key, values);
  }
}

async function appendThreadPromptLegacy(
  storage: CloudflareDurableObjectTransactionStorage,
  key: string,
  prompt: CloudflareScheduledThreadPrompt
): Promise<void> {
  const values = await readLegacyList<CloudflareScheduledThreadPrompt>(
    storage,
    key
  );
  const isDuplicate = values.some(
    (existing) =>
      existing.threadKey === prompt.threadKey &&
      existing.idempotencyKey === prompt.idempotencyKey &&
      existing.runId === prompt.runId
  );
  if (!isDuplicate) {
    values.push(prompt);
    await storage.put(key, values);
  }
}

async function removeFromLegacyList<T>(
  storage: CloudflareDurableObjectStorage,
  key: string,
  shouldRemove: (value: T) => boolean
): Promise<void> {
  await withTransaction(storage, async (tx) => {
    const remaining = (await readLegacyList<T>(tx, key)).filter(
      (value) => !shouldRemove(value)
    );
    await tx.put(key, remaining);
  });
}

async function readLegacyList<T>(
  storage: CloudflareDurableObjectTransactionStorage,
  key: string,
  limit?: number
): Promise<T[]> {
  const values = (await storage.get<readonly T[]>(key)) ?? [];
  return values
    .slice(0, normalizedListLimit(limit))
    .map((item) => structuredClone(item));
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

function scheduledWorkSql(
  storage: CloudflareDurableObjectTransactionStorage
): SqlStorage | undefined {
  const sql = storage.sql;
  if (
    typeof sql === "object" &&
    sql !== null &&
    "exec" in sql &&
    typeof sql.exec === "function"
  ) {
    return sql as SqlStorage;
  }
  return;
}

function scheduledRunsKey(prefix: string): string {
  return `${prefix}:scheduled-runs`;
}

function scheduledThreadPromptsKey(prefix: string): string {
  return `${prefix}:scheduled-session-prompts`;
}

function runScheduledWorkId(runId: string): string {
  return runId;
}

function threadPromptScheduledWorkId(
  prompt: CloudflareScheduledThreadPrompt
): string {
  return [
    prompt.threadKey,
    prompt.idempotencyKey ?? "",
    prompt.runId ?? "",
  ].join("\u0000");
}

function normalizedListLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
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
