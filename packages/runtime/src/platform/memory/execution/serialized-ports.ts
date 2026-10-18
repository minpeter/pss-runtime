import { transitionTurn } from "../../../execution/host/turn-status";
import type {
  CheckpointStore,
  EventStore,
  HostStoreTransaction,
  LeaseFencedCheckpointStore,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../../execution/host/types";
import type { ThreadStore } from "../../../thread/store/types";

export type MutationTransaction = Omit<
  HostStoreTransaction,
  "leaseFencedCheckpoints" | "threadEvents" | "turns"
> & {
  readonly leaseFencedCheckpoints: LeaseFencedCheckpointStore;
  readonly threadEvents: ThreadEventLog;
  readonly turns: TurnStore & {
    readonly transition: NonNullable<TurnStore["transition"]>;
  };
};

export type TransactionRunner = <T>(
  mutation: (tx: MutationTransaction) => Promise<T>
) => Promise<T>;

export function serializeCheckpointMutations(
  raw: CheckpointStore & LeaseFencedCheckpointStore,
  run: TransactionRunner
): CheckpointStore & LeaseFencedCheckpointStore {
  return {
    append: (checkpoint, options) =>
      run((tx) => tx.checkpoints.append(checkpoint, options)),
    appendFenced: (checkpoint, options) =>
      run((tx) => tx.leaseFencedCheckpoints.appendFenced(checkpoint, options)),
    latest: (runId) => raw.latest(runId),
  };
}

export function serializeEventMutations(
  raw: EventStore,
  run: TransactionRunner
): EventStore {
  return {
    append: (runId, event) => run((tx) => tx.events.append(runId, event)),
    read: (runId, cursor) => raw.read(runId, cursor),
  };
}

export function serializeInputMutations(
  run: TransactionRunner
): ThreadInputInbox {
  return {
    ack: (record) => run((tx) => tx.inputs.ack(record)),
    admit: (input) => run((tx) => tx.inputs.admit(input)),
    claimNext: (threadKey, boundary, options) =>
      run((tx) => tx.inputs.claimNext(threadKey, boundary, options)),
    markPromoted: (record) => run((tx) => tx.inputs.markPromoted(record)),
    recoverClaims: (threadKey, options) =>
      run((tx) => tx.inputs.recoverClaims(threadKey, options)),
    releaseClaim: (record) => run((tx) => tx.inputs.releaseClaim(record)),
  };
}

export function serializeNotificationMutations(
  raw: NotificationInbox,
  run: TransactionRunner
): NotificationInbox {
  return {
    claimByIdempotencyKey: (idempotencyKey) =>
      run((tx) => tx.notifications.claimByIdempotencyKey(idempotencyKey)),
    enqueue: (record) => run((tx) => tx.notifications.enqueue(record)),
    getByIdempotencyKey: (idempotencyKey) =>
      raw.getByIdempotencyKey(idempotencyKey),
    releaseByIdempotencyKey: (idempotencyKey) =>
      run((tx) => tx.notifications.releaseByIdempotencyKey(idempotencyKey)),
  };
}

export function serializeThreadEventMutations(
  raw: ThreadEventLog,
  run: TransactionRunner
): ThreadEventLog {
  return {
    append: (threadKey, event) =>
      run((tx) => tx.threadEvents.append(threadKey, event)),
    read: (threadKey, options) => raw.read(threadKey, options),
  };
}

export function serializeThreadMutations(
  raw: ThreadStore,
  run: TransactionRunner
): ThreadStore {
  return {
    commit: (key, next, options) =>
      run((tx) => tx.threads.commit(key, next, options)),
    delete: (key) => run((tx) => tx.threads.delete(key)),
    load: (key) => raw.load(key),
  };
}

export function serializeTurnMutations(
  raw: TurnStore,
  run: TransactionRunner
): TurnStore {
  return {
    claim: (runId, options) => run((tx) => tx.turns.claim(runId, options)),
    create: (record) => run((tx) => tx.turns.create(record)),
    get: (runId) => raw.get(runId),
    getByDedupeKey: (dedupeKey) => raw.getByDedupeKey(dedupeKey),
    listByParentRunId: (parentRunId) => raw.listByParentRunId(parentRunId),
    listByThreadKey: async (threadKey) =>
      (await raw.listByThreadKey?.(threadKey)) ?? [],
    transition: (runId, expected, update) =>
      run((tx) => transitionTurn(tx.turns, { expected, runId, update })),
    update: (record) => run((tx) => tx.turns.update(record)),
  };
}
