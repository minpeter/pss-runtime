import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type StoragePayloadKind,
  StoragePayloadSerializationError,
  serializedJsonByteLength,
} from "../payload-guard";
import { createPayloadChunkMarker } from "./payload-chunk-markers";
import {
  deletePayloadChunks,
  type PayloadChunkLocation,
} from "./payload-chunk-table";
import { chunkSerializedPayload } from "./utf8-chunks";

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
