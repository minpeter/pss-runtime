import type { AgentEvent } from "../../thread/protocol/events";
import type {
  CommitResult,
  ExpectedThreadVersion,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../../thread/store/types";
import type {
  Checkpoint,
  CheckpointStore,
  CheckpointWriteResult,
  EventCursor,
  EventStore,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  StoredAgentEvent,
  TurnStore,
} from "../host/types";
import { InMemoryNotificationInbox } from "./notifications";
import { InMemoryRunStore } from "./runs";
import type { ExecutionState } from "./state";
import { cloneState, createEmptyState } from "./state";

export class InMemoryExecutionStore implements ExecutionStore {
  #state = createEmptyState();
  #transactionChain: Promise<void> = Promise.resolve();
  readonly checkpoints: CheckpointStore = new InMemoryCheckpointStore(
    () => this.#state
  );
  readonly events: EventStore = new InMemoryEventStore(() => this.#state);
  readonly notifications: NotificationInbox = new InMemoryNotificationInbox(
    () => this.#state
  );
  readonly turns: TurnStore = new InMemoryRunStore(() => this.#state);
  readonly threads: ThreadStore = new InMemoryExecutionThreadStore(
    () => this.#state
  );
  get sessions(): ThreadStore {
    return this.threads;
  }

  async transaction<T>(
    fn: (tx: ExecutionStoreTransaction) => Promise<T>
  ): Promise<T> {
    const previousTransaction = this.#transactionChain;
    let releaseTransaction: () => void = () => undefined;
    this.#transactionChain = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previousTransaction;
    const transactionState = cloneState(this.#state);
    const transactionStore = new InMemoryTransactionStore(transactionState);
    try {
      const result = await fn(transactionStore);
      this.#state = transactionState;
      return result;
    } finally {
      releaseTransaction();
    }
  }
}

class InMemoryTransactionStore implements ExecutionStoreTransaction {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly notifications: NotificationInbox;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;
  readonly #state: ExecutionState;

  constructor(state: ExecutionState) {
    this.#state = state;
    this.checkpoints = new InMemoryCheckpointStore(() => this.#state);
    this.events = new InMemoryEventStore(() => this.#state);
    this.notifications = new InMemoryNotificationInbox(() => this.#state);
    this.turns = new InMemoryRunStore(() => this.#state);
    this.threads = new InMemoryExecutionThreadStore(() => this.#state);
  }

  get sessions(): ThreadStore {
    return this.threads;
  }
}

class InMemoryExecutionThreadStore implements ThreadStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  commit(
    key: string,
    next: ThreadStoreCommit,
    options: { readonly expectedVersion: ExpectedThreadVersion }
  ): Promise<CommitResult> {
    const state = this.#state();
    const current = state.threads.get(key);
    const currentVersion = current?.version ?? null;

    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const versionNumber = (state.threadVersions.get(key) ?? 0) + 1;
    const version = String(versionNumber);
    state.threadVersions.set(key, versionNumber);
    state.threads.set(key, structuredClone({ state: next.state, version }));
    return Promise.resolve({ ok: true, version });
  }

  delete(key: string): Promise<void> {
    const state = this.#state();
    state.threads.delete(key);
    state.threadVersions.delete(key);
    return Promise.resolve();
  }

  load(key: string): Promise<StoredThread | null> {
    const stored = this.#state().threads.get(key);
    return Promise.resolve(stored ? structuredClone(stored) : null);
  }
}

class InMemoryCheckpointStore implements CheckpointStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  append(
    checkpoint: Checkpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    const run = this.#state().turns.get(checkpoint.runId);
    const currentVersion = run?.checkpointVersion ?? 0;
    if (currentVersion !== options.expectedVersion) {
      return Promise.resolve({
        currentVersion,
        ok: false,
        reason: "stale-version",
      });
    }

    const stored = structuredClone(checkpoint);
    const checkpoints = this.#state().checkpoints.get(checkpoint.runId) ?? [];
    checkpoints.push(stored);
    this.#state().checkpoints.set(checkpoint.runId, checkpoints);
    if (run) {
      this.#state().turns.set(checkpoint.runId, {
        ...run,
        checkpointVersion: checkpoint.version,
      });
    }

    return Promise.resolve({ ok: true, version: checkpoint.version });
  }

  latest(runId: string): Promise<Checkpoint | null> {
    const checkpoints = this.#state().checkpoints.get(runId) ?? [];
    const checkpoint = checkpoints.at(-1);
    return Promise.resolve(checkpoint ? structuredClone(checkpoint) : null);
  }
}

class InMemoryEventStore implements EventStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  append(runId: string, event: AgentEvent): Promise<EventCursor> {
    const events = this.#state().events.get(runId) ?? [];
    const cursor = { offset: events.length + 1 };
    events.push({
      cursor,
      event: structuredClone(event),
      runId,
    });
    this.#state().events.set(runId, events);
    return Promise.resolve(cursor);
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    await Promise.resolve();
    const events = this.#state().events.get(runId) ?? [];
    const start = cursor?.offset ?? 0;
    for (const event of events.slice(start)) {
      yield structuredClone(event);
    }
  }
}
