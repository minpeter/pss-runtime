import type {
  CheckpointStore,
  CheckpointWriteResult,
  RunCheckpoint,
} from "../../../execution";
import type { SqlStorage } from "../../sql/ports/storage-port";
import type { CloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey, withTransaction } from "../execution/records";
import { getRun, putRun } from "../execution/run-records";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
  stringifyJsonPayloadWithinBudget,
} from "../payload-guard";

interface CheckpointRow {
  readonly checkpoint: string;
  readonly version: number;
}

/**
 * Append-only SQLite-backed {@link CheckpointStore} for SQLite-backed Durable
 * Objects.
 *
 * Persists one small SQLite row per checkpoint. A run with many tool-call
 * checkpoints can no longer reach the Durable Object ~2MB per-value limit
 * (`SQLITE_TOOBIG`) by accumulation.
 *
 * The optimistic version check reads the run record (`RunStore`) as the
 * version authority. The check, the row `INSERT`, and the `RunStore` bump run
 * inside a single `storage.transaction`
 * so concurrent writes to the same run serialize — exactly one wins, the rest
 * get `stale-version`. (`ctx.storage.sql.exec` issued inside a Durable Object
 * transaction is part of that transaction, per the Cloudflare SQLite storage
 * API.)
 */
export class DurableObjectSqliteCheckpointStore implements CheckpointStore {
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #sql: SqlStorage;
  readonly #storage: CloudflareDurableObjectStorage;
  #schemaReady = false;

  constructor(
    storage: CloudflareDurableObjectStorage,
    prefix: string,
    options: StoragePayloadBudgetOptions = {}
  ) {
    const sql = storage.sql as SqlStorage | undefined;
    if (!sql) {
      throw new Error(
        "DurableObjectSqliteCheckpointStore requires a SQLite-backed Durable Object (storage.sql is unavailable)"
      );
    }
    this.#maxPayloadBytes = resolveStoragePayloadMaxBytes(options);
    this.#prefix = prefix;
    this.#sql = sql;
    this.#storage = storage;
  }

  async append(
    checkpoint: RunCheckpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    this.#ensureSchema();
    return await withTransaction(this.#storage, async (storage) => {
      const run = await getRun(storage, this.#prefix, checkpoint.runId);
      const currentVersion = run?.checkpointVersion ?? 0;
      if (currentVersion !== options.expectedVersion) {
        return {
          currentVersion,
          ok: false,
          reason: "stale-version",
        };
      }

      const key = this.#rowKey(checkpoint.runId);
      const serializedCheckpoint = stringifyJsonPayloadWithinBudget(
        "checkpoint",
        checkpoint,
        this.#maxPayloadBytes
      );
      this.#sql.exec(
        "INSERT INTO pss_checkpoint (run_key, version, checkpoint) VALUES (?, ?, ?)",
        key,
        checkpoint.version,
        serializedCheckpoint
      );
      if (run) {
        await putRun(
          storage,
          this.#prefix,
          {
            ...run,
            checkpointVersion: checkpoint.version,
          },
          { maxPayloadBytes: this.#maxPayloadBytes }
        );
      }
      return { ok: true, version: checkpoint.version };
    });
  }

  latest(runId: string): Promise<RunCheckpoint | null> {
    this.#ensureSchema();
    const rows = this.#sql
      .exec<CheckpointRow>(
        "SELECT version, checkpoint FROM pss_checkpoint WHERE run_key = ? ORDER BY version DESC LIMIT 1",
        this.#rowKey(runId)
      )
      .toArray();
    const row = rows[0];
    return Promise.resolve(
      row ? (JSON.parse(row.checkpoint) as RunCheckpoint) : null
    );
  }

  #rowKey(runId: string): string {
    return storeKey(this.#prefix, "checkpoints", runId);
  }

  #ensureSchema(): void {
    if (this.#schemaReady) {
      return;
    }
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS pss_checkpoint (run_key TEXT NOT NULL, version INTEGER NOT NULL, checkpoint TEXT NOT NULL, PRIMARY KEY (run_key, version))"
    );
    this.#schemaReady = true;
  }
}
