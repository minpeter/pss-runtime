import type {
  CheckpointStore,
  EventStore,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  RunStore,
} from "../execution";
import type { SessionStore } from "../index";
import { DurableObjectCheckpointStore } from "./cloudflare-checkpoint-store";
import { DurableObjectEventStore } from "./cloudflare-event-store";
import { DurableObjectExecutionSessionStore } from "./cloudflare-execution-session-store";
import { DurableObjectNotificationInbox } from "./cloudflare-notification-store";
import { DurableObjectRunStore } from "./cloudflare-run-store";
import { DurableObjectSqliteCheckpointStore } from "./cloudflare-sqlite-checkpoint-store";
import { DurableObjectSqliteEventStore } from "./cloudflare-sqlite-event-store";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";
import type { SqlStorage } from "./sql-storage";

// `sql` is read structurally so the shared CloudflareDurableObjectStorage port
// stays free of a `sql` member (see DurableObjectSqliteSessionStore). A
// SQLite-backed Durable Object exposes `storage.sql` at runtime; a transaction
// clone (or a non-SQLite DO) yields undefined and falls back to the legacy
// KV-backed stores — which is correct because events/checkpoints are appended
// directly (never inside a host transaction) on the production Cloudflare path.
const sqliteOf = (
  storage: CloudflareDurableObjectStorage
): SqlStorage | undefined => (storage as { sql?: SqlStorage }).sql;

export class DurableObjectExecutionStore implements ExecutionStore {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly notifications: NotificationInbox;
  readonly runs: RunStore;
  readonly sessions: SessionStore;
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor({
    prefix = "pss-runtime",
    storage,
  }: {
    readonly prefix?: string;
    readonly storage: CloudflareDurableObjectStorage;
  }) {
    this.#prefix = prefix;
    this.#storage = storage;
    // SQLite-backed Durable Objects store events/checkpoints one row per entry
    // (append-only). This avoids the ~2MB per-value `SQLITE_TOOBIG` failure the
    // legacy KV stores hit when a run accumulates many large tool-call events or
    // full-history checkpoints. Non-SQLite storage falls back to the KV stores.
    const sql = sqliteOf(storage);
    this.checkpoints = sql
      ? new DurableObjectSqliteCheckpointStore(storage, prefix)
      : new DurableObjectCheckpointStore(storage, prefix);
    this.events = sql
      ? new DurableObjectSqliteEventStore(storage, prefix)
      : new DurableObjectEventStore(storage, prefix);
    this.notifications = new DurableObjectNotificationInbox(storage, prefix);
    this.runs = new DurableObjectRunStore(storage, prefix);
    this.sessions = new DurableObjectExecutionSessionStore(storage, prefix);
  }

  async transaction<T>(
    fn: (tx: ExecutionStoreTransaction) => Promise<T>
  ): Promise<T> {
    if (this.#storage.transaction) {
      return await this.#storage.transaction((storage) =>
        fn(new DurableObjectExecutionStore({ prefix: this.#prefix, storage }))
      );
    }

    return await fn(this);
  }
}
