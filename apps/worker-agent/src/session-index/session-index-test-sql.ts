import { DatabaseSync } from "node:sqlite";

const RETURNS_ROWS = /^\s*(select|with|pragma)\b/i;
const HAS_RETURNING = /\breturning\b/i;

export interface TestSqlCursor<T> extends Iterable<T> {
  toArray(): T[];
}

export interface TestSqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): TestSqlCursor<T>;
}

/**
 * Test-only `SqlStorage` backed by Node's built-in `node:sqlite`, mirroring the
 * synchronous cursor shape of Cloudflare's `ctx.storage.sql.exec`. Used to
 * exercise the worker session index against a real SQL engine in vitest.
 */
export function createNodeTestSqlStorage(): TestSqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): TestSqlCursor<T> {
      const params = bindings as (bigint | null | number | string)[];
      if (RETURNS_ROWS.test(query) || HAS_RETURNING.test(query)) {
        return toCursor(db.prepare(query).all(...params) as T[]);
      }
      if (params.length === 0) {
        db.exec(query);
        return toCursor<T>([]);
      }
      db.prepare(query).run(...params);
      return toCursor<T>([]);
    },
  };
}

function toCursor<T>(rows: T[]): TestSqlCursor<T> {
  return {
    toArray: () => rows,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}
