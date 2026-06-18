import type {
  CheckpointStore,
  EventStore,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  RunStore,
} from "../execution";
import type { SessionStore } from "../index";
import { DurableObjectNotificationInbox } from "./cloudflare-notification-store";
import { DurableObjectRunStore } from "./cloudflare-run-store";
import { DurableObjectSqliteCheckpointStore } from "./cloudflare-sqlite-checkpoint-store";
import { DurableObjectSqliteEventStore } from "./cloudflare-sqlite-event-store";
import { DurableObjectSqliteSessionStore } from "./cloudflare-sqlite-session-store";
import {
  type CloudflareDurableObjectStorage,
  withSqlStorage,
} from "./durable-object-storage";

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
    this.checkpoints = new DurableObjectSqliteCheckpointStore(storage, prefix);
    this.events = new DurableObjectSqliteEventStore(storage, prefix);
    this.notifications = new DurableObjectNotificationInbox(storage, prefix);
    this.runs = new DurableObjectRunStore(storage, prefix);
    this.sessions = new DurableObjectSqliteSessionStore(storage, prefix);
  }

  async transaction<T>(
    fn: (tx: ExecutionStoreTransaction) => Promise<T>
  ): Promise<T> {
    if (this.#storage.transaction) {
      return await this.#storage.transaction((storage) =>
        fn(
          new DurableObjectExecutionStore({
            prefix: this.#prefix,
            storage: withSqlStorage(storage, storage.sql ?? this.#storage.sql),
          })
        )
      );
    }

    return await fn(this);
  }
}
