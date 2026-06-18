import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import { DurableObjectSqliteSessionStore } from "./session-store";

export const PREFIX = "pss-runtime";
export const REQUIRES_SQLITE = /SQLite-backed/;

interface MessageRowProbe {
  readonly active: number;
  readonly message: string;
  readonly seq: number;
}

export function createStore(): {
  readonly storage: InMemoryCloudflareDurableObjectStorage;
  readonly store: DurableObjectSqliteSessionStore;
} {
  const storage = new InMemoryCloudflareDurableObjectStorage({
    sql: new InMemorySqlStorage(),
  });
  const store = new DurableObjectSqliteSessionStore(storage, PREFIX);
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
