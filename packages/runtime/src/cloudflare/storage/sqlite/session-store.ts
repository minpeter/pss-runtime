import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "../../../index";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { CloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";

interface MetaRow {
  readonly message_count: number;
  readonly next_seq: number;
  readonly state_blob: string | null;
  readonly version: string;
}

interface MessageRow {
  readonly message: string;
  readonly seq: number;
}

interface SessionSnapshotV1 {
  readonly history: unknown[];
  readonly schemaVersion: 1;
}

/**
 * Append-only session store for SQLite-backed Durable Objects.
 *
 * Snapshot v1 state (`{ schemaVersion: 1, history }`) is split into rows. Any
 * other opaque state is stored verbatim in a single meta blob column, so the
 * store remains a correct drop-in {@link SessionStore} for non-snapshot callers.
 *
 * Concurrency: the optimistic version check and the row writes form a single
 * synchronous (await-free) read-modify-write section, so concurrent commits to
 * the same key serialize on the JS event loop inside the single-threaded
 * Durable Object — exactly one writer wins, the rest get a `conflict`.
 */
export class DurableObjectSqliteSessionStore implements SessionStore {
  readonly #prefix: string;
  readonly #sql: SqlStorage;
  #schemaReady = false;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    const sql = storage.sql as SqlStorage | undefined;
    if (!sql) {
      throw new Error(
        "DurableObjectSqliteSessionStore requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#prefix = prefix;
    this.#sql = sql;
  }

  commit(
    threadKey: string,
    next: SessionStoreCommit,
    options: { readonly expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult> {
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);

    // --- begin synchronous read-modify-write critical section (no await) ---
    const meta = this.#readMeta(key);
    const currentVersion = meta ? meta.version : null;
    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const version = String(versionCounter(meta?.version) + 1);
    const nextSeqStart = meta?.next_seq ?? 0;

    if (isSnapshotV1(next.state)) {
      const nextSeq = this.#writeHistoryRows(
        key,
        next.state.history,
        nextSeqStart
      );
      this.#writeMeta(key, {
        message_count: next.state.history.length,
        next_seq: nextSeq,
        state_blob: null,
        version,
      });
    } else {
      this.#softDeleteActiveRows(key);
      this.#writeMeta(key, {
        message_count: 0,
        next_seq: nextSeqStart,
        state_blob: JSON.stringify(next.state ?? null),
        version,
      });
    }
    // --- end critical section ---

    return Promise.resolve({ ok: true, version });
  }

  delete(threadKey: string): Promise<void> {
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);
    this.#sql.exec(
      "DELETE FROM pss_session_message WHERE session_key = ?",
      key
    );
    this.#sql.exec("DELETE FROM pss_session_meta WHERE session_key = ?", key);
    return Promise.resolve();
  }

  load(threadKey: string): Promise<StoredSession | null> {
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);

    const meta = this.#readMeta(key);
    if (!meta) {
      return Promise.resolve(null);
    }
    const version = meta.version;
    if (meta.state_blob !== null) {
      const state: unknown = JSON.parse(meta.state_blob);
      return Promise.resolve({ state, version });
    }
    const history: unknown[] = this.#readActiveMessages(key).map(
      (row) => JSON.parse(row.message) as unknown
    );
    return Promise.resolve({ state: { history, schemaVersion: 1 }, version });
  }

  #rowKey(threadKey: string): string {
    return storeKey(this.#prefix, "session", threadKey);
  }

  #ensureSchema(): void {
    if (this.#schemaReady) {
      return;
    }
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_session_message (session_key TEXT NOT NULL, seq INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, message TEXT NOT NULL, PRIMARY KEY (session_key, seq))"
    );
    this.#sql.exec(
      "CREATE INDEX IF NOT EXISTS pss_session_message_active ON pss_session_message (session_key, active, seq)"
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_session_meta (session_key TEXT PRIMARY KEY, version TEXT NOT NULL, message_count INTEGER NOT NULL, next_seq INTEGER NOT NULL, state_blob TEXT)"
    );
    this.#schemaReady = true;
  }

  #readMeta(key: string): MetaRow | null {
    const rows = this.#sql
      .exec<{
        message_count: number;
        next_seq: number;
        state_blob: string | null;
        version: number | string;
      }>(
        "SELECT version, message_count, next_seq, state_blob FROM pss_session_meta WHERE session_key = ?",
        key
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return null;
    }
    return { ...row, version: String(row.version) };
  }

  #readActiveMessages(key: string): MessageRow[] {
    return this.#sql
      .exec<MessageRow>(
        "SELECT seq, message FROM pss_session_message WHERE session_key = ? AND active = 1 ORDER BY seq",
        key
      )
      .toArray();
  }

  #writeHistoryRows(
    key: string,
    history: readonly unknown[],
    nextSeqStart: number
  ): number {
    const existing = this.#readActiveMessages(key);
    let prefix = 0;
    while (
      prefix < existing.length &&
      prefix < history.length &&
      existing[prefix].message === JSON.stringify(history[prefix])
    ) {
      prefix += 1;
    }
    if (prefix < existing.length) {
      // History diverged or shrank (rollback): soft-delete the divergent tail.
      this.#sql.exec(
        "UPDATE pss_session_message SET active = 0 WHERE session_key = ? AND active = 1 AND seq >= ?",
        key,
        existing[prefix].seq
      );
    }
    let seq = nextSeqStart;
    for (let index = prefix; index < history.length; index += 1) {
      this.#sql.exec(
        "INSERT INTO pss_session_message (session_key, seq, active, message) VALUES (?, ?, 1, ?)",
        key,
        seq,
        JSON.stringify(history[index])
      );
      seq += 1;
    }
    return seq;
  }

  #softDeleteActiveRows(key: string): void {
    this.#sql.exec(
      "UPDATE pss_session_message SET active = 0 WHERE session_key = ? AND active = 1",
      key
    );
  }

  #writeMeta(key: string, meta: MetaRow): void {
    this.#sql.exec(
      "INSERT INTO pss_session_meta (session_key, version, message_count, next_seq, state_blob) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET version = excluded.version, message_count = excluded.message_count, next_seq = excluded.next_seq, state_blob = excluded.state_blob",
      key,
      meta.version,
      meta.message_count,
      meta.next_seq,
      meta.state_blob
    );
  }
}

function versionCounter(version: string | undefined): number {
  const parsed = Number(version);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSnapshotV1(value: unknown): value is SessionSnapshotV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    "history" in value &&
    Array.isArray((value as { history?: unknown }).history)
  );
}
