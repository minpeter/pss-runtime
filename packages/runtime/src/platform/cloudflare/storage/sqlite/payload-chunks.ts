import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type StoragePayloadKind,
  StoragePayloadSerializationError,
  StoragePayloadTooLargeError,
  serializedJsonByteLength,
} from "../payload-guard";

const payloadChunkMarkerPrefix = "\u001epss-payload-chunk:";
const textEncoder = new TextEncoder();

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
  const totalBytes = textEncoder.encode(serialized).byteLength;
  if (totalBytes <= chunkMaxBytes) {
    return [serialized];
  }
  if (totalBytes === serialized.length) {
    const chunks: string[] = [];
    for (let index = 0; index < serialized.length; index += chunkMaxBytes) {
      chunks.push(serialized.slice(index, index + chunkMaxBytes));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let currentStart = 0;
  while (currentStart < serialized.length) {
    const firstEnd = nextCodePointEnd(serialized, currentStart);
    let low = firstEnd;
    let high = Math.max(
      firstEnd,
      Math.min(serialized.length, currentStart + chunkMaxBytes)
    );
    let best = firstEnd;
    while (low <= high) {
      const mid = avoidTrailingHighSurrogate(
        serialized,
        Math.floor((low + high) / 2)
      );
      if (mid <= currentStart) {
        break;
      }
      const byteLength = textEncoder.encode(
        serialized.slice(currentStart, mid)
      ).byteLength;
      if (byteLength <= chunkMaxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    chunks.push(serialized.slice(currentStart, best));
    currentStart = best;
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

function avoidTrailingHighSurrogate(value: string, index: number): number {
  if (index <= 0 || index >= value.length) {
    return index;
  }
  const previous = value.charCodeAt(index - 1);
  return previous >= 0xd8_00 && previous <= 0xdb_ff ? index - 1 : index;
}

function nextCodePointEnd(value: string, index: number): number {
  if (index >= value.length) {
    return index;
  }
  const first = value.charCodeAt(index);
  const second = value.charCodeAt(index + 1);
  return first >= 0xd8_00 &&
    first <= 0xdb_ff &&
    second >= 0xdc_00 &&
    second <= 0xdf_ff
    ? index + 2
    : index + 1;
}
