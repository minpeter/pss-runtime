import type {
  CommitResult,
  ExpectedThreadVersion,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../../../index";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { CloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
  stringifyJsonPayloadWithinBudget,
} from "../payload-guard";
import {
  deleteThreadRows,
  ensureThreadSchema,
  readActiveThreadMessages,
  readThreadMeta,
  softDeleteActiveThreadRows,
  threadRowKey,
  writeThreadHistoryRows,
  writeThreadMeta,
} from "./thread-store-sql";

interface ThreadSnapshotV1 {
  readonly history: unknown[];
  readonly schemaVersion: 1;
}

/**
 * Append-only thread store for SQLite-backed Durable Objects.
 *
 * Snapshot v1 state (`{ schemaVersion: 1, history }`) is split into rows. Any
 * other opaque state is stored verbatim in a single meta blob column, so the
 * store remains a correct drop-in {@link ThreadStore} for non-snapshot callers.
 *
 * Concurrency: the optimistic version check and the row writes form a single
 * synchronous (await-free) read-modify-write section, so concurrent commits to
 * the same key serialize on the JS event loop inside the single-threaded
 * Durable Object — exactly one writer wins, the rest get a `conflict`.
 */
export class DurableObjectSqliteThreadStore implements ThreadStore {
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #sql: SqlStorage;
  #schemaReady = false;

  constructor(
    storage: CloudflareDurableObjectStorage,
    prefix: string,
    options: StoragePayloadBudgetOptions = {}
  ) {
    const sql = storage.sql as SqlStorage | undefined;
    if (!sql) {
      throw new Error(
        "DurableObjectSqliteThreadStore requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#maxPayloadBytes = resolveStoragePayloadMaxBytes(options);
    this.#prefix = prefix;
    this.#sql = sql;
  }

  commit(
    threadKey: string,
    next: ThreadStoreCommit,
    options: { readonly expectedVersion: ExpectedThreadVersion }
  ): Promise<CommitResult> {
    try {
      this.#ensureSchema();
      const key = this.#rowKey(threadKey);

      // --- begin synchronous read-modify-write critical section (no await) ---
      const meta = readThreadMeta(this.#sql, key);
      const currentVersion = meta ? meta.version : null;
      if (options.expectedVersion !== currentVersion) {
        return Promise.resolve({ ok: false, reason: "conflict" });
      }

      const version = String(versionCounter(meta?.version) + 1);
      const nextSeqStart = meta?.next_seq ?? 0;

      if (isSnapshotV1(next.state)) {
        const nextSeq = writeThreadHistoryRows({
          history: next.state.history,
          key,
          maxPayloadBytes: this.#maxPayloadBytes,
          meta,
          nextSeqStart,
          sql: this.#sql,
        });
        writeThreadMeta(this.#sql, key, {
          message_count: next.state.history.length,
          next_seq: nextSeq,
          state_blob: null,
          version,
        });
      } else {
        const stateBlob = stringifyJsonPayloadWithinBudget(
          "thread-state",
          next.state ?? null,
          this.#maxPayloadBytes
        );
        softDeleteActiveThreadRows(this.#sql, key);
        writeThreadMeta(this.#sql, key, {
          message_count: 0,
          next_seq: nextSeqStart,
          state_blob: stateBlob,
          version,
        });
      }
      // --- end critical section ---

      return Promise.resolve({ ok: true, version });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  delete(threadKey: string): Promise<void> {
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);
    deleteThreadRows(this.#sql, key);
    return Promise.resolve();
  }

  load(threadKey: string): Promise<StoredThread | null> {
    this.#ensureSchema();
    const key = this.#rowKey(threadKey);

    const meta = readThreadMeta(this.#sql, key);
    if (!meta) {
      return Promise.resolve(null);
    }
    const version = meta.version;
    if (meta.state_blob !== null) {
      const state: unknown = JSON.parse(meta.state_blob);
      return Promise.resolve({ state, version });
    }
    const history: unknown[] = readActiveThreadMessages(this.#sql, key).map(
      (row) => JSON.parse(row.message)
    );
    return Promise.resolve({ state: { history, schemaVersion: 1 }, version });
  }

  #rowKey(threadKey: string): string {
    return threadRowKey(this.#prefix, threadKey);
  }

  #ensureSchema(): void {
    if (this.#schemaReady) {
      return;
    }
    ensureThreadSchema(this.#sql);
    this.#schemaReady = true;
  }
}

function versionCounter(version: string | undefined): number {
  const parsed = Number(version);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSnapshotV1(value: unknown): value is ThreadSnapshotV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    "history" in value &&
    Array.isArray((value as { history?: unknown }).history)
  );
}
