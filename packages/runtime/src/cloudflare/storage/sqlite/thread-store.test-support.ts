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
      "SELECT seq, active, message FROM pss_session_message WHERE session_key = ? ORDER BY seq",
      storeKey(PREFIX, "session", threadKey)
    )
    .toArray();
}
