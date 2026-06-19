import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import { DurableObjectSqliteThreadStore } from "./thread-store";

export const PREFIX = "pss-runtime";
export const REQUIRES_SQLITE = /SQLite-backed/;

interface MessageRowProbe {
  readonly active: number;
  readonly message: string;
  readonly seq: number;
}

interface MessageChunkRowProbe {
  readonly chunk: string;
  readonly chunk_index: number;
  readonly seq: number;
}

export function createStore(
  options: { readonly maxPayloadBytes?: number } = {}
): {
  readonly storage: InMemoryCloudflareDurableObjectStorage;
  readonly store: DurableObjectSqliteThreadStore;
} {
  const storage = new InMemoryCloudflareDurableObjectStorage({
    sql: new InMemorySqlStorage(),
  });
  const store = new DurableObjectSqliteThreadStore(storage, PREFIX, options);
  return { storage, store };
}

export function snapshot(history: unknown[]): {
  readonly state: {
    readonly history: unknown[];
    readonly schemaVersion: 1;
  };
} {
  return { state: { history, schemaVersion: 1 } };
}

export function readRows(
  storage: InMemoryCloudflareDurableObjectStorage,
  threadKey: string
): MessageRowProbe[] {
  return (storage.sql as InMemorySqlStorage)
    .exec<MessageRowProbe>(
      "SELECT seq, active, message FROM pss_thread_message WHERE thread_key = ? ORDER BY seq",
      storeKey(PREFIX, "thread", threadKey)
    )
    .toArray();
}

export function readChunkRows(
  storage: InMemoryCloudflareDurableObjectStorage,
  threadKey: string
): MessageChunkRowProbe[] {
  return (storage.sql as InMemorySqlStorage)
    .exec<MessageChunkRowProbe>(
      "SELECT seq, chunk_index, chunk FROM pss_thread_message_chunk WHERE thread_key = ? ORDER BY seq, chunk_index",
      storeKey(PREFIX, "thread", threadKey)
    )
    .toArray();
}
