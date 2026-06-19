import type { RunRecord } from "../../../execution";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { CloudflareDurableObjectTransactionStorage } from "../durable-object/durable-object-storage";
import {
  assertJsonPayloadWithinBudget,
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { readList, storeKey } from "./records";

interface RunRow {
  readonly record: string;
}

export async function getRun(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  runId: string
): Promise<RunRecord | null> {
  const sql = sqlStorage(storage);
  if (sql) {
    const row = selectRunRow(sql, prefix, runId);
    if (row) {
      return parseRunRecord(row);
    }
  }

  const legacy =
    (await storage.get<RunRecord>(storeKey(prefix, "run", runId))) ?? null;
  if (legacy && sql) {
    await putRun(storage, prefix, legacy);
    await storage.delete(storeKey(prefix, "run", runId));
  }
  return legacy;
}

export async function getRunByDedupeKey(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  dedupeKey: string
): Promise<RunRecord | null> {
  const sql = sqlStorage(storage);
  if (sql) {
    ensureRunSchema(sql);
    const row = sql
      .exec<RunRow>(
        "SELECT record FROM pss_run WHERE prefix = ? AND dedupe_key = ? LIMIT 1",
        prefix,
        dedupeKey
      )
      .toArray()[0];
    return row ? parseRunRecord(row) : null;
  }
  const runId = await storage.get<string>(
    storeKey(prefix, "run-dedupe", dedupeKey)
  );
  return runId ? await getRun(storage, prefix, runId) : null;
}

export async function listRunsByParentRunId(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  parentRunId: string
): Promise<readonly RunRecord[]> {
  const sql = sqlStorage(storage);
  if (sql) {
    ensureRunSchema(sql);
    return sql
      .exec<RunRow>(
        "SELECT record FROM pss_run WHERE prefix = ? AND parent_run_id = ? ORDER BY created_at, rowid",
        prefix,
        parentRunId
      )
      .toArray()
      .map(parseRunRecord);
  }
  const runIds = await readList<string>(
    storage,
    storeKey(prefix, "run-parent", parentRunId)
  );
  const runs = await Promise.all(
    runIds.map((runId) => getRun(storage, prefix, runId))
  );
  return runs.filter(isRunRecord);
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
  const sql = sqlStorage(storage);
  if (sql) {
    putSqlRun(sql, prefix, record);
    await storage.delete(storeKey(prefix, "run", record.runId));
    return;
  }
  await storage.put(storeKey(prefix, "run", record.runId), record);
}

export async function indexRun(
  storage: CloudflareDurableObjectTransactionStorage,
  prefix: string,
  record: RunRecord
): Promise<void> {
  if (hasSqlStorage(storage)) {
    return;
  }
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

function hasSqlStorage(
  storage: CloudflareDurableObjectTransactionStorage
): boolean {
  return sqlStorage(storage) !== undefined;
}

function selectRunRow(
  sql: SqlStorage,
  prefix: string,
  runId: string
): RunRow | undefined {
  ensureRunSchema(sql);
  return sql
    .exec<RunRow>(
      "SELECT record FROM pss_run WHERE prefix = ? AND run_id = ?",
      prefix,
      runId
    )
    .toArray()[0];
}

function parseRunRecord(row: RunRow): RunRecord {
  return JSON.parse(row.record) as RunRecord;
}

function isRunRecord(record: RunRecord | null): record is RunRecord {
  return record !== null;
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

function ensureRunSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_run (prefix TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL, dedupe_key TEXT, parent_run_id TEXT, root_run_id TEXT NOT NULL, thread_key TEXT NOT NULL, status TEXT NOT NULL, checkpoint_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (prefix, run_id))"
  );
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS pss_run_dedupe_unique ON pss_run (prefix, dedupe_key) WHERE dedupe_key IS NOT NULL"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_run_parent ON pss_run (prefix, parent_run_id, created_at)"
  );
}

function putSqlRun(sql: SqlStorage, prefix: string, record: RunRecord): void {
  ensureRunSchema(sql);
  const nowMs = Date.now();
  sql.exec(
    "INSERT INTO pss_run (prefix, run_id, record, dedupe_key, parent_run_id, root_run_id, thread_key, status, checkpoint_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(prefix, run_id) DO UPDATE SET record = excluded.record, dedupe_key = excluded.dedupe_key, parent_run_id = excluded.parent_run_id, root_run_id = excluded.root_run_id, thread_key = excluded.thread_key, status = excluded.status, checkpoint_version = excluded.checkpoint_version, updated_at = excluded.updated_at",
    prefix,
    record.runId,
    JSON.stringify(record),
    record.dedupeKey ?? null,
    record.parentRunId ?? null,
    record.rootRunId,
    record.threadKey,
    record.status,
    record.checkpointVersion,
    nowMs,
    nowMs
  );
}
