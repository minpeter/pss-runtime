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
  if (storage.transaction === undefined) {
    throw new MissingCloudflareTransactionError();
  }
  return await storage.transaction((tx) =>
    fn(tx.sql === undefined ? withSqlStorage(tx, storage.sql) : tx)
  );
}

export class MissingCloudflareTransactionError extends Error {
  constructor() {
    super("Cloudflare Durable Object storage transaction() is required.");
    this.name = "MissingCloudflareTransactionError";
  }
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
