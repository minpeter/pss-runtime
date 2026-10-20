import type { SqlStorage } from "../../../../sql/ports/storage-port";
import {
  StoragePayloadTooLargeError,
  serializedJsonByteLength,
  stringifyJsonPayloadWithinBudget,
} from "../../../payload-guard";
import { chunkSerializedPayload } from "../../utf8-chunks";
import type {
  RawThreadMessageRow,
  ThreadMessageChunkMarker,
  ThreadMessageChunkRow,
} from "../keys/types";

export const threadMessageChunkMarkerPrefix = "\u001epss-thread-chunk:";

export function stringifyThreadMessagePayload(
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

export function readThreadMessageChunks(
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

export function reconstructThreadMessagePayload(
  key: string,
  row: RawThreadMessageRow,
  marker: ThreadMessageChunkMarker,
  chunks: readonly ThreadMessageChunkRow[]
): string {
  if (chunks.length !== marker.n) {
    throw new Error(
      `Missing chunked thread message payload for ${key} seq ${row.seq}`
    );
  }
  return chunks.map((chunk) => chunk.chunk).join("");
}

export function rawThreadMessageEquals(
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

export function parseThreadMessageChunkMarker(
  message: string
): ThreadMessageChunkMarker | null {
  if (!message.startsWith(threadMessageChunkMarkerPrefix)) {
    return null;
  }
  const count = Number(message.slice(threadMessageChunkMarkerPrefix.length));
  return Number.isInteger(count) && count > 0 ? { n: count } : null;
}

function createThreadChunkMarker(
  chunkCount: number,
  maxPayloadBytes: number
): string {
  const marker = `${threadMessageChunkMarkerPrefix}${chunkCount}`;
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
