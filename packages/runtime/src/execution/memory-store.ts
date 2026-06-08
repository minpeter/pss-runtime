import type { AgentEvent } from "../session/events";
import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "../session/store/types";
import { InMemoryNotificationInbox } from "./memory-notifications";
import type { ExecutionState } from "./memory-state";
import { cloneState, createEmptyState } from "./memory-state";
import type {
  CheckpointStore,
  CheckpointWriteResult,
  ClaimRunOptions,
  ClaimRunResult,
  EventCursor,
  EventStore,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  RunCheckpoint,
  RunRecord,
  RunStatus,
  RunStore,
  StoredAgentEvent,
} from "./types";

const claimableStatuses = new Set<RunStatus>([
  "leased",
  "queued",
  "running",
  "suspended",
]);

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
  readonly runs: RunStore = new InMemoryRunStore(() => this.#state);
  readonly sessions: SessionStore = new InMemoryExecutionSessionStore(
    () => this.#state
  );

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
  readonly runs: RunStore;
  readonly sessions: SessionStore;
  readonly #state: ExecutionState;

  constructor(state: ExecutionState) {
    this.#state = state;
    this.checkpoints = new InMemoryCheckpointStore(() => this.#state);
    this.events = new InMemoryEventStore(() => this.#state);
    this.notifications = new InMemoryNotificationInbox(() => this.#state);
    this.runs = new InMemoryRunStore(() => this.#state);
    this.sessions = new InMemoryExecutionSessionStore(() => this.#state);
  }
}

class InMemoryExecutionSessionStore implements SessionStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  commit(
    key: string,
    next: SessionStoreCommit,
    options: { readonly expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult> {
    const state = this.#state();
    const current = state.sessions.get(key);
    const currentVersion = current?.version ?? null;

    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const versionNumber = (state.sessionVersions.get(key) ?? 0) + 1;
    const version = String(versionNumber);
    state.sessionVersions.set(key, versionNumber);
    state.sessions.set(key, structuredClone({ state: next.state, version }));
    return Promise.resolve({ ok: true, version });
  }

  delete(key: string): Promise<void> {
    const state = this.#state();
    state.sessions.delete(key);
    state.sessionVersions.delete(key);
    return Promise.resolve();
  }

  load(key: string): Promise<StoredSession | null> {
    const stored = this.#state().sessions.get(key);
    return Promise.resolve(stored ? structuredClone(stored) : null);
  }
}

class InMemoryRunStore implements RunStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  create(record: RunRecord): Promise<RunRecord> {
    const stored = structuredClone(record);
    this.#state().runs.set(record.runId, stored);
    return Promise.resolve(structuredClone(stored));
  }

  get(runId: string): Promise<RunRecord | null> {
    const record = this.#state().runs.get(runId);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  getByDedupeKey(dedupeKey: string): Promise<RunRecord | null> {
    const record = [...this.#state().runs.values()].find(
      (candidate) => candidate.dedupeKey === dedupeKey
    );
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  listByParentRunId(parentRunId: string): Promise<readonly RunRecord[]> {
    const records = [...this.#state().runs.values()].filter(
      (candidate) => candidate.parentRunId === parentRunId
    );
    return Promise.resolve(records.map((record) => structuredClone(record)));
  }

  update(record: RunRecord): Promise<RunRecord> {
    const stored = structuredClone(record);
    this.#state().runs.set(record.runId, stored);
    return Promise.resolve(structuredClone(stored));
  }

  claim(runId: string, options: ClaimRunOptions): Promise<ClaimRunResult> {
    const record = this.#state().runs.get(runId);
    if (!record) {
      return Promise.resolve({ ok: false, reason: "not-found" });
    }

    if (!claimableStatuses.has(record.status)) {
      return Promise.resolve({ ok: false, reason: "not-claimable" });
    }

    if (record.lease && record.lease.leaseUntilMs > options.nowMs) {
      return Promise.resolve({ ok: false, reason: "leased" });
    }

    const lease = {
      attempt: options.attempt,
      leaseId: options.leaseId,
      leaseUntilMs: options.nowMs + options.leaseMs,
    };
    const claimed: RunRecord = {
      ...record,
      lease,
      status: "leased",
    };
    this.#state().runs.set(runId, claimed);
    return Promise.resolve({
      lease,
      ok: true,
      record: structuredClone(claimed),
    });
  }
}

class InMemoryCheckpointStore implements CheckpointStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  append(
    checkpoint: RunCheckpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    const run = this.#state().runs.get(checkpoint.runId);
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
      this.#state().runs.set(checkpoint.runId, {
        ...run,
        checkpointVersion: checkpoint.version,
      });
    }

    return Promise.resolve({ ok: true, version: checkpoint.version });
  }

  latest(runId: string): Promise<RunCheckpoint | null> {
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
