import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type StoragePayloadKind,
  StoragePayloadSerializationError,
  StoragePayloadTooLargeError,
  serializedJsonByteLength,
} from "../payload-guard";

const payloadChunkMarkerPrefix = "\u001epss-payload-chunk:";

interface PayloadChunkRow {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly payload_key?: string;
}

export interface StoredPayloadRow {
  readonly payloadKey: string;
  readonly storedPayload: string;
}

export interface PayloadChunkLocation {
  readonly ownerKey: string;
  readonly payloadKey: string;
  readonly scope: string;
}

export function ensurePayloadChunkSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_payload_chunk (scope TEXT NOT NULL, owner_key TEXT NOT NULL, payload_key TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (scope, owner_key, payload_key, chunk_index))"
  );
}

export function deletePayloadChunks(
  sql: SqlStorage,
  location: PayloadChunkLocation
): void {
  sql.exec(
    "DELETE FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key = ?",
    location.scope,
    location.ownerKey,
    location.payloadKey
  );
}

export function readJsonPayloadFromSqlRows(
  sql: SqlStorage,
  location: PayloadChunkLocation,
  storedPayload: string
): string {
  const marker = parsePayloadChunkMarker(storedPayload);
  if (!marker) {
    return storedPayload;
  }

  const chunks = sql
    .exec<PayloadChunkRow>(
      "SELECT chunk_index, chunk FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key = ? ORDER BY chunk_index",
      location.scope,
      location.ownerKey,
      location.payloadKey
    )
    .toArray();
  if (chunks.length !== marker.n) {
    throw new Error(
      `Missing chunked ${location.scope} payload for ${location.ownerKey} ${location.payloadKey}`
    );
  }
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.chunk_index !== index) {
      throw new Error(
        `Out-of-order chunked ${location.scope} payload for ${location.ownerKey} ${location.payloadKey}`
      );
    }
  }
  return chunks.map((chunk) => chunk.chunk).join("");
}

export function readJsonPayloadsFromSqlRows(
  sql: SqlStorage,
  scope: string,
  ownerKey: string,
  rows: readonly StoredPayloadRow[]
): Map<string, string> {
  const payloads = new Map<string, string>();
  const chunkMarkers = new Map<string, { readonly n: number }>();
  for (const row of rows) {
    const marker = parsePayloadChunkMarker(row.storedPayload);
    if (marker) {
      chunkMarkers.set(row.payloadKey, marker);
    } else {
      payloads.set(row.payloadKey, row.storedPayload);
    }
  }
  if (chunkMarkers.size === 0) {
    return payloads;
  }

  const payloadKeys = [...chunkMarkers.keys()];
  const placeholders = payloadKeys.map(() => "?").join(",");
  const chunks = sql
    .exec<PayloadChunkRow>(
      `SELECT payload_key, chunk_index, chunk FROM pss_payload_chunk WHERE scope = ? AND owner_key = ? AND payload_key IN (${placeholders}) ORDER BY payload_key, chunk_index`,
      scope,
      ownerKey,
      ...payloadKeys
    )
    .toArray();
  const grouped = new Map<string, PayloadChunkRow[]>();
  for (const chunk of chunks) {
    if (chunk.payload_key === undefined) {
      continue;
    }
    const group = grouped.get(chunk.payload_key);
    if (group) {
      group.push(chunk);
    } else {
      grouped.set(chunk.payload_key, [chunk]);
    }
  }
  for (const [payloadKey, marker] of chunkMarkers) {
    const group = grouped.get(payloadKey) ?? [];
    if (group.length !== marker.n) {
      throw new Error(
        `Missing chunked ${scope} payload for ${ownerKey} ${payloadKey}`
      );
    }
    for (const [index, chunk] of group.entries()) {
      if (chunk.chunk_index !== index) {
        throw new Error(
          `Out-of-order chunked ${scope} payload for ${ownerKey} ${payloadKey}`
        );
      }
    }
    payloads.set(payloadKey, group.map((chunk) => chunk.chunk).join(""));
  }
  return payloads;
}

export function writeJsonPayloadToSqlRows(
  sql: SqlStorage,
  location: PayloadChunkLocation,
  payloadKind: StoragePayloadKind,
  value: unknown,
  maxPayloadBytes: number
): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new StoragePayloadSerializationError(payloadKind);
  }

  deletePayloadChunks(sql, location);
  if (serializedJsonByteLength(serialized) <= maxPayloadBytes) {
    return serialized;
  }

  const chunks = chunkSerializedPayload(serialized, maxPayloadBytes);
  const marker = createPayloadChunkMarker(
    payloadKind,
    chunks.length,
    maxPayloadBytes
  );
  for (const [index, chunk] of chunks.entries()) {
    sql.exec(
      "INSERT INTO pss_payload_chunk (scope, owner_key, payload_key, chunk_index, chunk) VALUES (?, ?, ?, ?, ?)",
      location.scope,
      location.ownerKey,
      location.payloadKey,
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

function parsePayloadChunkMarker(
  payload: string
): { readonly n: number } | null {
  if (!payload.startsWith(payloadChunkMarkerPrefix)) {
    return null;
  }
  const count = Number(payload.slice(payloadChunkMarkerPrefix.length));
  return Number.isInteger(count) && count > 0 ? { n: count } : null;
}

function createPayloadChunkMarker(
  payloadKind: StoragePayloadKind,
  chunkCount: number,
  maxPayloadBytes: number
): string {
  const marker = `${payloadChunkMarkerPrefix}${chunkCount}`;
  const byteLength = serializedJsonByteLength(marker);
  if (byteLength > maxPayloadBytes) {
    throw new StoragePayloadTooLargeError({
      byteLength,
      maxBytes: maxPayloadBytes,
      payloadKind,
    });
  }
  return marker;
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
