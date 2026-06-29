import type { SqlStorage, SqlStorageCursorLike } from "../ports/storage-port";
import { selectSqlRows } from "./select";
import {
  cloneInMemoryDurableObjectSqlState,
  createInMemoryDurableObjectSqlState,
  type InMemoryDurableObjectSqlState,
} from "./state";
import { writeSqlStatement } from "./write";

export class InMemoryDurableObjectSqlStorage implements SqlStorage {
  #state: InMemoryDurableObjectSqlState = createInMemoryDurableObjectSqlState();

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> {
    const normalized = normalizeSql(query);
    if (isSchemaStatement(normalized) || isTransactionStatement(normalized)) {
      return toCursor<T>([]);
    }

    if (normalized.startsWith("select ")) {
      return toCursor<T>(selectSqlRows(this.#state, normalized, bindings));
    }

    writeSqlStatement(this.#state, normalized, bindings);
    return toCursor<T>([]);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const previous = cloneInMemoryDurableObjectSqlState(this.#state);
    try {
      return await fn();
    } catch (error) {
      this.#state = previous;
      throw error;
    }
  }

  transactionSync<T>(fn: () => T): T {
    const previous = cloneInMemoryDurableObjectSqlState(this.#state);
    try {
      return fn();
    } catch (error) {
      this.#state = previous;
      throw error;
    }
  }
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function isSchemaStatement(query: string): boolean {
  return (
    query.startsWith("create table ") ||
    query.startsWith("alter table ") ||
    query.startsWith("create index ") ||
    query.startsWith("create unique index ")
  );
}

function isTransactionStatement(query: string): boolean {
  return query === "begin" || query === "commit" || query === "rollback";
}

function toCursor<T>(rows: readonly unknown[]): SqlStorageCursorLike<T> {
  const cursorRows = rows as T[];
  return {
    toArray: () => cursorRows,
    [Symbol.iterator]: () => cursorRows[Symbol.iterator](),
  };
}
