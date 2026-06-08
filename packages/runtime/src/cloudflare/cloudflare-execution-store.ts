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
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";

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
    this.checkpoints = new DurableObjectCheckpointStore(storage, prefix);
    this.events = new DurableObjectEventStore(storage, prefix);
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
