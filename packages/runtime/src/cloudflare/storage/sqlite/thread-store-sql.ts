import type { SqlStorage } from "../../sql/ports/storage-port";
import { storeKey } from "../execution/records";
import {
  serializedJsonByteLength,
  stringifyJsonPayloadWithinBudget,
} from "../payload-guard";

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

interface WriteHistoryRowsOptions {
  readonly history: readonly unknown[];
  readonly key: string;
  readonly maxPayloadBytes: number;
  readonly meta: ThreadMetaRow | null;
  readonly nextSeqStart: number;
  readonly sql: SqlStorage;
}

export function threadRowKey(prefix: string, threadKey: string): string {
  return storeKey(prefix, "thread", threadKey);
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
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_thread_message_chunk (thread_key TEXT NOT NULL, seq INTEGER NOT NULL, chunk_index INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (thread_key, seq, chunk_index))"
  );
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
    .toArray()
    .map((row) => ({ ...row, message: hydrateThreadMessage(sql, key, row) }));
}

export function writeThreadHistoryRows(
  options: WriteHistoryRowsOptions
): number {
  const { history, key, maxPayloadBytes, meta, nextSeqStart, sql } = options;
  if (
    meta?.state_blob === null &&
    history.length > meta.message_count &&
    meta.next_seq === nextSeqStart
  ) {
    return insertThreadMessages({
      history: history.slice(meta.message_count),
      key,
      maxPayloadBytes,
      seq: nextSeqStart,
      sql,
    });
  }

  const existing = readActiveThreadMessages(sql, key);
  let prefix = 0;
  while (
    prefix < existing.length &&
    prefix < history.length &&
    existing[prefix].message === JSON.stringify(history[prefix])
  ) {
    prefix += 1;
  }
  if (prefix < existing.length) {
    sql.exec(
      "UPDATE pss_thread_message SET active = 0 WHERE thread_key = ? AND active = 1 AND seq >= ?",
      key,
      existing[prefix].seq
    );
  }
  return insertThreadMessages({
    history: history.slice(prefix),
    key,
    maxPayloadBytes,
    seq: nextSeqStart,
    sql,
  });
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

export function deleteThreadRows(sql: SqlStorage, key: string): void {
  sql.exec("DELETE FROM pss_thread_message_chunk WHERE thread_key = ?", key);
  sql.exec("DELETE FROM pss_thread_message WHERE thread_key = ?", key);
  sql.exec("DELETE FROM pss_thread_meta WHERE thread_key = ?", key);
}

function insertThreadMessages({
  history,
  key,
  maxPayloadBytes,
  seq,
  sql,
}: {
  readonly history: readonly unknown[];
  readonly key: string;
  readonly maxPayloadBytes: number;
  readonly seq: number;
  readonly sql: SqlStorage;
}): number {
  let nextSeq = seq;
  for (const value of history) {
    const message = stringifyThreadMessagePayload(
      sql,
      key,
      nextSeq,
      value,
      maxPayloadBytes
    );
    sql.exec(
      "INSERT INTO pss_thread_message (thread_key, seq, active, message) VALUES (?, ?, 1, ?)",
      key,
      nextSeq,
      message
    );
    nextSeq += 1;
  }
  return nextSeq;
}

function stringifyThreadMessagePayload(
  sql: SqlStorage,
  key: string,
  seq: number,
  value: unknown,
  maxPayloadBytes: number
): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return stringifyJsonPayloadWithinBudget(
      "thread-message",
      value,
      maxPayloadBytes
    );
  }
  if (serializedJsonByteLength(serialized) <= maxPayloadBytes) {
    return serialized;
  }

  const chunks = chunkSerializedPayload(serialized, maxPayloadBytes);
  for (const [index, chunk] of chunks.entries()) {
    sql.exec(
      "INSERT INTO pss_thread_message_chunk (thread_key, seq, chunk_index, chunk) VALUES (?, ?, ?, ?)",
      key,
      seq,
      index,
      chunk
    );
  }
  return JSON.stringify({ $pss: "chunk", n: chunks.length });
}

function chunkSerializedPayload(
  serialized: string,
  maxPayloadBytes: number
): string[] {
  const chunkMaxBytes = Math.max(1, maxPayloadBytes);
  const chunks: string[] = [];
  let current = "";
  for (const char of serialized) {
    const next = current + char;
    if (current && serializedJsonByteLength(next) > chunkMaxBytes) {
      chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function hydrateThreadMessage(
  sql: SqlStorage,
  key: string,
  row: ThreadMessageRow
): string {
  const marker = parseThreadMessageChunkMarker(row.message);
  if (!marker) {
    return row.message;
  }
  const chunks = sql
    .exec<{ chunk: string }>(
      "SELECT chunk FROM pss_thread_message_chunk WHERE thread_key = ? AND seq = ? ORDER BY chunk_index",
      key,
      row.seq
    )
    .toArray();
  if (chunks.length !== marker.n) {
    throw new Error(
      `Missing chunked thread message payload for ${key} seq ${row.seq}`
    );
  }
  return chunks.map((chunk) => chunk.chunk).join("");
}

function parseThreadMessageChunkMarker(
  message: string
): { readonly n: number } | null {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "$pss" in parsed &&
      (parsed as { $pss?: unknown }).$pss === "chunk" &&
      "n" in parsed &&
      typeof (parsed as { n?: unknown }).n === "number"
    ) {
      return { n: (parsed as { n: number }).n };
    }
  } catch {
    return null;
  }
  return null;
}
