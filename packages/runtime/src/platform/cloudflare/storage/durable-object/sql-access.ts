import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type CloudflareDurableObjectStorage,
  type CloudflareDurableObjectTransactionStorage,
  isSqlStorage,
  withSqlStorage,
} from "./durable-object-storage";

export async function withTransaction<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectTransactionStorage) => Promise<T>
): Promise<T> {
  return storage.transaction
    ? await storage.transaction((tx) =>
        fn(tx.sql === undefined ? withSqlStorage(tx, storage.sql) : tx)
      )
    : await fn(storage);
}

export function requiredSqlStorage(
  storage: CloudflareDurableObjectTransactionStorage,
  requirer: string
): SqlStorage {
  const sql = storage.sql;
  if (isSqlStorage(sql)) {
    return sql;
  }
  throw new Error(`${requirer} requires SQLite storage.`);
}
