import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "../index";
import { storeKey } from "./cloudflare-store-utils";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";
import type { SqlStorage } from "./sql-storage";

interface MetaRow {
  readonly message_count: number;
  readonly next_seq: number;
  readonly state_blob: string | null;
  readonly version: number;
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
 * Unlike {@link DurableObjectExecutionSessionStore}, which re-serializes the
 * entire session snapshot into a single `storage.put` value every commit (and
 * eventually crosses the Durable Object ~2MB per-value limit on long sessions),
 * this store persists the message history as one small SQLite row per message.
 * Each commit only INSERTs the messages that are new since the last commit, so
 * no single stored value grows with the conversation and `SQLITE_TOOBIG` can no
 * longer be reached by accumulation.
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
  readonly #migrated = new Set<string>();
  readonly #prefix: string;
  readonly #sql: SqlStorage;
  readonly #storage: CloudflareDurableObjectStorage;
  #schemaReady = false;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    // `sql` is read structurally so the shared CloudflareDurableObjectStorage
    // port stays free of a `sql` member — otherwise a real `DurableObjectStorage`
    // would stop being assignable to it. SQLite-backed Durable Objects expose
    // `storage.sql` at runtime; a non-SQLite DO yields undefined and throws here.
    const sql = (storage as { sql?: SqlStorage }).sql;
    if (!sql) {
      throw new Error(
        "DurableObjectSqliteSessionStore requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#prefix = prefix;
    this.#sql = sql;
    this.#storage = storage;
  }

  async commit(
    sessionKey: string,
    next: SessionStoreCommit,
    options: { readonly expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult> {
    this.#ensureSchema();
    const key = this.#rowKey(sessionKey);
    await this.#ensureMigrated(key, sessionKey);

    // --- begin synchronous read-modify-write critical section (no await) ---
    const meta = this.#readMeta(key);
    const currentVersion = meta ? String(meta.version) : null;
    if (options.expectedVersion !== currentVersion) {
      return { ok: false, reason: "conflict" };
    }

    const version = (meta?.version ?? 0) + 1;
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

    return { ok: true, version: String(version) };
  }

  async delete(sessionKey: string): Promise<void> {
    this.#ensureSchema();
    const key = this.#rowKey(sessionKey);
    this.#sql.exec(
      "DELETE FROM pss_session_message WHERE session_key = ?",
      key
    );
    this.#sql.exec("DELETE FROM pss_session_meta WHERE session_key = ?", key);
    await this.#storage.delete(key);
    await this.#storage.delete(
      storeKey(this.#prefix, "session-version", sessionKey)
    );
  }

  async load(sessionKey: string): Promise<StoredSession | null> {
    this.#ensureSchema();
    const key = this.#rowKey(sessionKey);
    await this.#ensureMigrated(key, sessionKey);

    const meta = this.#readMeta(key);
    if (!meta) {
      return null;
    }
    const version = String(meta.version);
    if (meta.state_blob !== null) {
      const state: unknown = JSON.parse(meta.state_blob);
      return { state, version };
    }
    const history: unknown[] = this.#readActiveMessages(key).map(
      (row) => JSON.parse(row.message) as unknown
    );
    return { state: { history, schemaVersion: 1 }, version };
  }

  #rowKey(sessionKey: string): string {
    return storeKey(this.#prefix, "session", sessionKey);
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
      "CREATE TABLE IF NOT EXISTS pss_session_meta (session_key TEXT PRIMARY KEY, version INTEGER NOT NULL, message_count INTEGER NOT NULL, next_seq INTEGER NOT NULL, state_blob TEXT)"
    );
    this.#schemaReady = true;
  }

  #readMeta(key: string): MetaRow | null {
    const rows = this.#sql
      .exec<MetaRow>(
        "SELECT version, message_count, next_seq, state_blob FROM pss_session_meta WHERE session_key = ?",
        key
      )
      .toArray();
    return rows[0] ?? null;
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

  async #ensureMigrated(key: string, sessionKey: string): Promise<void> {
    if (this.#migrated.has(key)) {
      return;
    }
    if (this.#readMeta(key)) {
      this.#migrated.add(key);
      return;
    }
    const legacy = await this.#storage.get<StoredSession>(key);
    // Re-check after the await: a concurrent commit/load may have migrated.
    if (this.#migrated.has(key) || this.#readMeta(key)) {
      this.#migrated.add(key);
      return;
    }
    if (legacy) {
      const seedVersionRaw = Number(legacy.version);
      const version = Number.isFinite(seedVersionRaw) ? seedVersionRaw : 0;
      if (isSnapshotV1(legacy.state)) {
        const nextSeq = this.#writeHistoryRows(key, legacy.state.history, 0);
        this.#writeMeta(key, {
          message_count: legacy.state.history.length,
          next_seq: nextSeq,
          state_blob: null,
          version,
        });
      } else {
        this.#writeMeta(key, {
          message_count: 0,
          next_seq: 0,
          state_blob: JSON.stringify(legacy.state ?? null),
          version,
        });
      }
      this.#migrated.add(key);
      await this.#storage.delete(key);
      await this.#storage.delete(
        storeKey(this.#prefix, "session-version", sessionKey)
      );
      return;
    }
    this.#migrated.add(key);
  }
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
