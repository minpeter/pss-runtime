import type {
  CheckpointStore,
  EventStore,
  HostScheduler,
  HostStore,
  HostStoreTransaction,
  LeaseFencedCheckpointStore,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../../../execution";
import {
  type ScheduledThreadPrompt,
  threadPromptScheduledWorkId,
} from "../../../../execution/scheduled-work";
import type { ThreadStore } from "../../../../thread/store/types";
import type { SqlStorage } from "../../sql/ports/storage-port";
import {
  type DurableObjectStorage,
  type DurableObjectTransactionStorage,
  isSqlStorage,
  withSqlStorage,
} from "../durable-object/durable-object-storage";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { DurableObjectSqliteCheckpointStore } from "../sqlite/checkpoint-store";
import { DurableObjectSqliteEventStore } from "../sqlite/event-store";
import { insertScheduledWorkInTransaction } from "../sqlite/scheduled-work-table";
import { DurableObjectSqliteThreadEventLog } from "../sqlite/thread-event-log";
import { DurableObjectSqliteThreadStore } from "../sqlite/thread-store";
import { DurableObjectThreadInputInbox } from "./input-store";
import { DurableObjectNotificationInbox } from "./notification-store";
import { DurableObjectRunStore } from "./run-store";
import { deleteThreadRows } from "./store-thread-cleanup";
export class DurableObjectExecutionStore implements HostStore {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly inputs: ThreadInputInbox;
  readonly leaseFencedCheckpoints: LeaseFencedCheckpointStore;
  readonly notifications: NotificationInbox;
  readonly scheduler: HostScheduler;
  readonly threadEvents: ThreadEventLog;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #storage: DurableObjectStorage;
  readonly #createTransactionScheduler?: (
    storage: DurableObjectTransactionStorage
  ) => HostScheduler;

  constructor({
    createTransactionScheduler,
    maxPayloadBytes,
    prefix = "pss-runtime",
    storage,
  }: {
    readonly createTransactionScheduler?: (
      storage: DurableObjectTransactionStorage
    ) => HostScheduler;
    readonly maxPayloadBytes?: StoragePayloadBudgetOptions["maxPayloadBytes"];
    readonly prefix?: string;
    readonly storage: DurableObjectStorage;
  }) {
    this.#createTransactionScheduler = createTransactionScheduler;
    this.#maxPayloadBytes = maxPayloadBytes ?? resolveStoragePayloadMaxBytes();
    this.#prefix = prefix;
    this.#storage = storage;
    const payloadBudget = { maxPayloadBytes: this.#maxPayloadBytes };
    const checkpoints = new DurableObjectSqliteCheckpointStore(
      storage,
      prefix,
      payloadBudget
    );
    this.checkpoints = checkpoints;
    this.leaseFencedCheckpoints = checkpoints;
    this.events = new DurableObjectSqliteEventStore(
      storage,
      prefix,
      payloadBudget
    );
    this.threadEvents = new DurableObjectSqliteThreadEventLog(
      storage,
      prefix,
      payloadBudget
    );
    this.notifications = new DurableObjectNotificationInbox(
      storage,
      prefix,
      payloadBudget
    );
    this.inputs = new DurableObjectThreadInputInbox(
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
    this.scheduler = createTransactionScheduler
      ? createTransactionScheduler(storage)
      : {
          enqueueRun: (runId, options) => {
            const runAfterMs = options?.runAfterMs;
            const dueAtMs =
              runAfterMs === undefined
                ? undefined
                : Date.now() + Math.max(0, Math.floor(runAfterMs));
            insertScheduledWorkInTransaction(
              this.#storage,
              this.#prefix,
              "run",
              runId,
              runId,
              { ...(dueAtMs === undefined ? {} : { dueAtMs }), runId }
            );
            return Promise.resolve();
          },
          resumeThread: (threadKey, options) => {
            const prompt: ScheduledThreadPrompt = {
              idempotencyKey: options.idempotencyKey,
              notificationId: options.notificationId,
              runId: options.runId,
              threadKey,
            };
            insertScheduledWorkInTransaction(
              this.#storage,
              this.#prefix,
              "thread-prompt",
              threadPromptScheduledWorkId(prompt),
              prompt,
              { runId: prompt.runId, threadKey }
            );
            return Promise.resolve();
          },
        };
  }

  get sessions(): ThreadStore {
    return this.threads;
  }

  async deleteThread(threadKey: string): Promise<void> {
    await this.transaction((tx) => {
      const store = tx as DurableObjectExecutionStore;
      deleteThreadRows(
        store.#storage.sql as SqlStorage,
        store.#prefix,
        threadKey
      );
      return Promise.resolve();
    });
  }

  async transaction<T>(
    fn: (tx: HostStoreTransaction) => Promise<T>
  ): Promise<T> {
    const runTx = (storage: DurableObjectTransactionStorage, sql: unknown) =>
      fn(
        new DurableObjectExecutionStore({
          createTransactionScheduler: this.#createTransactionScheduler,
          maxPayloadBytes: this.#maxPayloadBytes,
          prefix: this.#prefix,
          storage: withSqlStorage(storage, sql),
        })
      );
    if (this.#storage.transaction) {
      return await this.#storage.transaction((storage) =>
        runTx(storage, storage.sql ?? this.#storage.sql)
      );
    }
    const sql = transactionalSqlStorage(this.#storage.sql);
    if (sql) {
      return await sql.transaction(() => runTx(this.#storage, sql));
    }
    throw new Error(
      "DurableObjectExecutionStore requires Durable Object storage.transaction or storage.sql.transaction for atomic transactions."
    );
  }
}

interface TransactionalSqlStorage extends SqlStorage {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

function transactionalSqlStorage(
  value: unknown
): TransactionalSqlStorage | undefined {
  if (!isSqlStorage(value)) {
    return;
  }
  const transaction = value.transaction?.bind(value);
  if (!transaction) {
    return;
  }
  return {
    exec: (query, ...bindings) => value.exec(query, ...bindings),
    transaction: (fn) => transaction(fn),
    ...(value.transactionSync
      ? { transactionSync: (fn) => value.transactionSync?.(fn) ?? fn() }
      : {}),
  };
}
