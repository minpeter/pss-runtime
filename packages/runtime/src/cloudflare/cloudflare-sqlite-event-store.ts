import type { EventCursor, EventStore, StoredAgentEvent } from "../execution";
import type { AgentEvent } from "../index";
import { storeKey } from "./cloudflare-store-utils";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";
import type { SqlStorage } from "./sql-storage";

interface EventRow {
  readonly event: string;
  readonly seq: number;
}

interface EventMetaRow {
  readonly next_seq: number;
}

/**
 * Append-only SQLite-backed {@link EventStore} for SQLite-backed Durable Objects.
 *
 * Each `append` only `INSERT`s the new event as one small SQLite row, so no
 * single stored value grows with the run length.
 *
 * Mirrors the design of {@link DurableObjectSqliteSessionStore}: the per-run
 * `next_seq` counter and the row `INSERT` form a single synchronous
 * (await-free) read-modify-write section, so concurrent appends to the same run
 * serialize on the JS event loop inside the single-threaded Durable Object and
 * no `seq` collision can occur.
 *
 * Event cursors are 1-based skip counts (`offset = seq + 1`).
 */
export class DurableObjectSqliteEventStore implements EventStore {
  readonly #prefix: string;
  readonly #sql: SqlStorage;
  #schemaReady = false;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    const sql = storage.sql as SqlStorage | undefined;
    if (!sql) {
      throw new Error(
        "DurableObjectSqliteEventStore requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#prefix = prefix;
    this.#sql = sql;
  }

  append(runId: string, event: AgentEvent): Promise<EventCursor> {
    this.#ensureSchema();
    const key = this.#rowKey(runId);
    // Synchronous read-modify-write critical section (no await): concurrent
    // appends to the same run serialize on the JS event loop inside the
    // single-threaded Durable Object, so no `seq` collision can occur.
    const seq = this.#consumeNextSeq(key);
    this.#sql.exec(
      "INSERT INTO pss_event (run_key, seq, event) VALUES (?, ?, ?)",
      key,
      seq,
      JSON.stringify(event)
    );
    return Promise.resolve({ offset: seq + 1 });
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    await Promise.resolve();
    this.#ensureSchema();
    const key = this.#rowKey(runId);
    const start = cursor?.offset ?? 0;
    const rows = this.#sql
      .exec<EventRow>(
        "SELECT seq, event FROM pss_event WHERE run_key = ? AND seq >= ? ORDER BY seq",
        key,
        start
      )
      .toArray();
    for (const row of rows) {
      yield {
        cursor: { offset: row.seq + 1 },
        event: JSON.parse(row.event) as AgentEvent,
        runId,
      };
    }
  }

  #rowKey(runId: string): string {
    return storeKey(this.#prefix, "events", runId);
  }

  #ensureSchema(): void {
    if (this.#schemaReady) {
      return;
    }
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_event (run_key TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_key, seq))"
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_event_meta (run_key TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)"
    );
    this.#schemaReady = true;
  }

  #consumeNextSeq(key: string): number {
    const row = this.#sql
      .exec<EventMetaRow>(
        "SELECT next_seq FROM pss_event_meta WHERE run_key = ?",
        key
      )
      .toArray()[0];
    const seq = row?.next_seq ?? 0;
    this.#sql.exec(
      "INSERT INTO pss_event_meta (run_key, next_seq) VALUES (?, ?) ON CONFLICT(run_key) DO UPDATE SET next_seq = excluded.next_seq",
      key,
      seq + 1
    );
    return seq;
  }
}
