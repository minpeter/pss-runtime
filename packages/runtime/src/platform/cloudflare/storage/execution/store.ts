import type {
  CheckpointStore,
  EventStore,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  TurnStore,
} from "../../../../execution";
import type { ThreadStore } from "../../../../index";
import {
  type CloudflareDurableObjectStorage,
  withSqlStorage,
} from "../durable-object/durable-object-storage";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { DurableObjectSqliteCheckpointStore } from "../sqlite/checkpoint-store";
import { DurableObjectSqliteEventStore } from "../sqlite/event-store";
import { DurableObjectSqliteThreadStore } from "../sqlite/thread-store";
import { DurableObjectNotificationInbox } from "./notification-store";
import { DurableObjectRunStore } from "./run-store";

export class DurableObjectExecutionStore implements ExecutionStore {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly notifications: NotificationInbox;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor({
    maxPayloadBytes,
    prefix = "pss-runtime",
    storage,
  }: {
    readonly maxPayloadBytes?: StoragePayloadBudgetOptions["maxPayloadBytes"];
    readonly prefix?: string;
    readonly storage: CloudflareDurableObjectStorage;
  }) {
    this.#maxPayloadBytes = maxPayloadBytes ?? resolveStoragePayloadMaxBytes();
    this.#prefix = prefix;
    this.#storage = storage;
    const payloadBudget = { maxPayloadBytes: this.#maxPayloadBytes };
    this.checkpoints = new DurableObjectSqliteCheckpointStore(
      storage,
      prefix,
      payloadBudget
    );
    this.events = new DurableObjectSqliteEventStore(
      storage,
      prefix,
      payloadBudget
    );
    this.notifications = new DurableObjectNotificationInbox(
      storage,
      prefix,
      payloadBudget
    );
    this.turns = new DurableObjectRunStore(storage, prefix, payloadBudget);
    this.threads = new DurableObjectSqliteThreadStore(
      storage,
      prefix,
      payloadBudget
    );
  }

  get sessions(): ThreadStore {
    return this.threads;
  }

  async transaction<T>(
    fn: (tx: ExecutionStoreTransaction) => Promise<T>
  ): Promise<T> {
    if (this.#storage.transaction) {
      return await this.#storage.transaction((storage) =>
        fn(
          new DurableObjectExecutionStore({
            maxPayloadBytes: this.#maxPayloadBytes,
            prefix: this.#prefix,
            storage: withSqlStorage(storage, storage.sql ?? this.#storage.sql),
          })
        )
      );
    }

    return await fn(this);
  }
}
