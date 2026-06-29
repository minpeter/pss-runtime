import type { SqlStorage } from "../../../sql/ports/storage-port";
import type { ThreadMetaRow } from "./keys/types";

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
