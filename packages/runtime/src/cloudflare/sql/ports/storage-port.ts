/**
 * Minimal structural subset of Cloudflare's `SqlStorage` that the SQLite-backed
 * session store depends on. Keeping it narrow lets the store stay decoupled from
 * `@cloudflare/workers-types` while remaining assignable from the real
 * `ctx.storage.sql` (a SQLite-backed Durable Object) and from the in-memory
 * `node:sqlite` test double.
 */
export interface SqlStorageCursorLike<T> extends Iterable<T> {
  toArray(): T[];
}

export interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T>;
}
