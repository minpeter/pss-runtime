import type { SqlStorage } from "../../sql/ports/storage-port";
import { storeKey } from "../execution/records";
import {
  StoragePayloadTooLargeError,
  serializedJsonByteLength,
  stringifyJsonPayloadWithinBudget,
} from "../payload-guard";

const threadChunkMarkerPrefix = "\u001epss-thread-chunk:";

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

interface RawThreadMessageRow {
  readonly message: string;
  readonly seq: number;
}

interface ThreadMessageChunkRow {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly seq: number;
}

interface ThreadMessageChunkMarker {
  readonly kind: "legacy-json" | "raw-prefix";
  readonly n: number;
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
  const rows = sql
    .exec<ThreadMessageRow>(
      "SELECT seq, message FROM pss_thread_message WHERE thread_key = ? AND active = 1 ORDER BY seq",
      key
    )
    .toArray();
  const chunkMarkers = new Map<number, ThreadMessageChunkMarker>();
  for (const row of rows) {
    const marker = parseThreadMessageChunkMarker(row.message);
    if (marker) {
      chunkMarkers.set(row.seq, marker);
    }
  }
  if (chunkMarkers.size === 0) {
    return rows;
  }
  const chunks = readThreadMessageChunks(sql, key, [...chunkMarkers.keys()]);
  return rows.map((row) => {
    const marker = chunkMarkers.get(row.seq);
    if (!marker) {
      return row;
    }
    const rowChunks = chunks.get(row.seq) ?? [];
    if (rowChunks.length !== marker.n) {
      if (marker.kind === "legacy-json" && rowChunks.length === 0) {
        return row;
      }
      throw new Error(
        `Missing chunked thread message payload for ${key} seq ${row.seq}`
      );
    }
    return {
      ...row,
      message: rowChunks.map((chunk) => chunk.chunk).join(""),
    };
  });
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

  const existing = readRawActiveThreadMessages(sql, key);
  let prefix = 0;
  while (
    prefix < existing.length &&
    prefix < history.length &&
    rawThreadMessageEquals(sql, key, existing[prefix], history[prefix])
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

function readRawActiveThreadMessages(
  sql: SqlStorage,
  key: string
): RawThreadMessageRow[] {
  return sql
    .exec<RawThreadMessageRow>(
      "SELECT seq, message FROM pss_thread_message WHERE thread_key = ? AND active = 1 ORDER BY seq",
      key
    )
    .toArray();
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
  const marker = createThreadChunkMarker(chunks.length, maxPayloadBytes);
  for (const [index, chunk] of chunks.entries()) {
    sql.exec(
      "INSERT INTO pss_thread_message_chunk (thread_key, seq, chunk_index, chunk) VALUES (?, ?, ?, ?)",
      key,
      seq,
      index,
      chunk
    );
  }
  return marker;
}

function chunkSerializedPayload(
  serialized: string,
  maxPayloadBytes: number
): string[] {
  const chunkMaxBytes = Math.max(1, maxPayloadBytes);
  const chunks: string[] = [];
  let currentStart = 0;
  let currentBytes = 0;
  let index = 0;
  for (const char of serialized) {
    const charStart = index;
    const nextIndex = charStart + char.length;
    const charBytes = utf8ByteLength(char);
    if (currentBytes > 0 && currentBytes + charBytes > chunkMaxBytes) {
      chunks.push(serialized.slice(currentStart, charStart));
      currentStart = charStart;
      currentBytes = charBytes;
    } else {
      currentBytes += charBytes;
    }
    index = nextIndex;
  }
  if (currentStart < serialized.length) {
    chunks.push(serialized.slice(currentStart));
  }
  return chunks;
}

function readThreadMessageChunks(
  sql: SqlStorage,
  key: string,
  seqs: readonly number[]
): Map<number, readonly ThreadMessageChunkRow[]> {
  const placeholders = seqs.map(() => "?").join(",");
  const rows = sql
    .exec<ThreadMessageChunkRow>(
      `SELECT seq, chunk_index, chunk FROM pss_thread_message_chunk WHERE thread_key = ? AND seq IN (${placeholders}) ORDER BY seq, chunk_index`,
      key,
      ...seqs
    )
    .toArray();
  const chunks = new Map<number, ThreadMessageChunkRow[]>();
  for (const row of rows) {
    const group = chunks.get(row.seq);
    if (group) {
      group.push(row);
    } else {
      chunks.set(row.seq, [row]);
    }
  }
  return chunks;
}

function rawThreadMessageEquals(
  sql: SqlStorage,
  key: string,
  row: RawThreadMessageRow,
  value: unknown
): boolean {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return false;
  }
  if (row.message === serialized) {
    return true;
  }
  const marker = parseThreadMessageChunkMarker(row.message);
  if (!marker) {
    return false;
  }
  const chunks =
    readThreadMessageChunks(sql, key, [row.seq]).get(row.seq) ?? [];
  return (
    chunks.length === marker.n &&
    chunks.map((chunk) => chunk.chunk).join("") === serialized
  );
}

function utf8ByteLength(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7_ff) {
    return 2;
  }
  if (codePoint <= 0xff_ff) {
    return 3;
  }
  return 4;
}

function parseThreadMessageChunkMarker(
  message: string
): ThreadMessageChunkMarker | null {
  if (!message.startsWith(threadChunkMarkerPrefix)) {
    return parseLegacyThreadMessageChunkMarker(message);
  }
  const count = Number(message.slice(threadChunkMarkerPrefix.length));
  return Number.isInteger(count) && count > 0
    ? { kind: "raw-prefix", n: count }
    : null;
}

function parseLegacyThreadMessageChunkMarker(
  message: string
): ThreadMessageChunkMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("$pss" in parsed) ||
    !("n" in parsed) ||
    parsed.$pss !== "chunk" ||
    typeof parsed.n !== "number"
  ) {
    return null;
  }
  return Number.isInteger(parsed.n) && parsed.n > 0
    ? { kind: "legacy-json", n: parsed.n }
    : null;
}

function createThreadChunkMarker(
  chunkCount: number,
  maxPayloadBytes: number
): string {
  const marker = `${threadChunkMarkerPrefix}${chunkCount}`;
  const byteLength = serializedJsonByteLength(marker);
  if (byteLength > maxPayloadBytes) {
    throw new StoragePayloadTooLargeError({
      byteLength,
      maxBytes: maxPayloadBytes,
      payloadKind: "thread-message",
    });
  }
  return marker;
}
