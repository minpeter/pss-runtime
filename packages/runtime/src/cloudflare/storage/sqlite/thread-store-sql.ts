import type { SqlStorage } from "../../sql/ports/storage-port";
import { storeKey } from "../execution/records";
import { stringifyJsonPayloadWithinBudget } from "../payload-guard";

export interface ThreadMetaRow {
  readonly message_count: number;
  readonly next_seq: number;
  readonly state_blob: string | null;
  readonly version: string;
}

export interface ThreadMessageRow {
  readonly message: string;
  readonly seq: number;
}

interface LegacyThreadMessageRow extends ThreadMessageRow {
  readonly active: number;
}

interface TableNameRow {
  readonly name: string;
}

interface WriteHistoryRowsOptions {
  readonly history: readonly unknown[];
  readonly key: string;
  readonly maxPayloadBytes: number;
  readonly nextSeqStart: number;
  readonly sql: SqlStorage;
}

const legacyThreadMessageTable = "pss_session_message";
const legacyThreadMetaTable = "pss_session_meta";

export function threadRowKey(prefix: string, threadKey: string): string {
  return storeKey(prefix, "thread", threadKey);
}

export function legacyThreadRowKey(prefix: string, threadKey: string): string {
  return storeKey(prefix, "session", threadKey);
}

export function ensureThreadSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_message (thread_key TEXT NOT NULL, seq INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, message TEXT NOT NULL, PRIMARY KEY (thread_key, seq))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS pss_thread_message_active ON pss_thread_message (thread_key, active, seq)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_meta (thread_key TEXT PRIMARY KEY, version TEXT NOT NULL, message_count INTEGER NOT NULL, next_seq INTEGER NOT NULL, state_blob TEXT)"
  );
}

export function migrateLegacyThreadRows(
  sql: SqlStorage,
  prefix: string,
  threadKey: string
): void {
  const key = threadRowKey(prefix, threadKey);
  if (readThreadMeta(sql, key) || !legacyTablesExist(sql)) {
    return;
  }

  const legacyKey = legacyThreadRowKey(prefix, threadKey);
  const legacyMeta = readLegacyThreadMeta(sql, legacyKey);
  if (!legacyMeta) {
    return;
  }

  for (const row of readLegacyThreadMessages(sql, legacyKey)) {
    sql.exec(
      "INSERT INTO pss_thread_message (thread_key, seq, active, message) VALUES (?, ?, ?, ?)",
      key,
      row.seq,
      row.active,
      row.message
    );
  }
  writeThreadMeta(sql, key, legacyMeta);
  deleteLegacyThreadRows(sql, legacyKey);
}

export function readThreadMeta(
  sql: SqlStorage,
  key: string
): ThreadMetaRow | null {
  const row = sql
    .exec<{
      message_count: number;
      next_seq: number;
      state_blob: string | null;
      version: number | string;
    }>(
      "SELECT version, message_count, next_seq, state_blob FROM pss_thread_meta WHERE thread_key = ?",
      key
    )
    .toArray()[0];
  return row ? { ...row, version: String(row.version) } : null;
}

export function readActiveThreadMessages(
  sql: SqlStorage,
  key: string
): ThreadMessageRow[] {
  return sql
    .exec<ThreadMessageRow>(
      "SELECT seq, message FROM pss_thread_message WHERE thread_key = ? AND active = 1 ORDER BY seq",
      key
    )
    .toArray();
}

export function writeThreadHistoryRows(
  options: WriteHistoryRowsOptions
): number {
  const { history, key, maxPayloadBytes, nextSeqStart, sql } = options;
  const existing = readActiveThreadMessages(sql, key);
  let prefix = 0;
  while (
    prefix < existing.length &&
    prefix < history.length &&
    existing[prefix].message === JSON.stringify(history[prefix])
  ) {
    prefix += 1;
  }
  const messages = history
    .slice(prefix)
    .map((message) =>
      stringifyJsonPayloadWithinBudget(
        "thread-message",
        message,
        maxPayloadBytes
      )
    );
  if (prefix < existing.length) {
    sql.exec(
      "UPDATE pss_thread_message SET active = 0 WHERE thread_key = ? AND active = 1 AND seq >= ?",
      key,
      existing[prefix].seq
    );
  }
  let seq = nextSeqStart;
  for (const message of messages) {
    sql.exec(
      "INSERT INTO pss_thread_message (thread_key, seq, active, message) VALUES (?, ?, 1, ?)",
      key,
      seq,
      message
    );
    seq += 1;
  }
  return seq;
}

export function softDeleteActiveThreadRows(sql: SqlStorage, key: string): void {
  sql.exec(
    "UPDATE pss_thread_message SET active = 0 WHERE thread_key = ? AND active = 1",
    key
  );
}

export function writeThreadMeta(
  sql: SqlStorage,
  key: string,
  meta: ThreadMetaRow
): void {
  sql.exec(
    "INSERT INTO pss_thread_meta (thread_key, version, message_count, next_seq, state_blob) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_key) DO UPDATE SET version = excluded.version, message_count = excluded.message_count, next_seq = excluded.next_seq, state_blob = excluded.state_blob",
    key,
    meta.version,
    meta.message_count,
    meta.next_seq,
    meta.state_blob
  );
}

export function deleteThreadRows(
  sql: SqlStorage,
  key: string,
  legacyKey: string
): void {
  sql.exec("DELETE FROM pss_thread_message WHERE thread_key = ?", key);
  sql.exec("DELETE FROM pss_thread_meta WHERE thread_key = ?", key);
  deleteLegacyThreadRows(sql, legacyKey);
}

function legacyTablesExist(sql: SqlStorage): boolean {
  const rows = sql
    .exec<TableNameRow>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
      legacyThreadMetaTable,
      legacyThreadMessageTable
    )
    .toArray();
  const names = new Set(rows.map((row) => row.name));
  return (
    names.has(legacyThreadMetaTable) && names.has(legacyThreadMessageTable)
  );
}

function readLegacyThreadMeta(
  sql: SqlStorage,
  key: string
): ThreadMetaRow | null {
  const row = sql
    .exec<{
      message_count: number;
      next_seq: number;
      state_blob: string | null;
      version: number | string;
    }>(
      "SELECT version, message_count, next_seq, state_blob FROM pss_session_meta WHERE session_key = ?",
      key
    )
    .toArray()[0];
  return row ? { ...row, version: String(row.version) } : null;
}

function readLegacyThreadMessages(
  sql: SqlStorage,
  key: string
): LegacyThreadMessageRow[] {
  return sql
    .exec<LegacyThreadMessageRow>(
      "SELECT seq, active, message FROM pss_session_message WHERE session_key = ? ORDER BY seq",
      key
    )
    .toArray();
}

function deleteLegacyThreadRows(sql: SqlStorage, key: string): void {
  if (!legacyTablesExist(sql)) {
    return;
  }
  sql.exec("DELETE FROM pss_session_message WHERE session_key = ?", key);
  sql.exec("DELETE FROM pss_session_meta WHERE session_key = ?", key);
}
