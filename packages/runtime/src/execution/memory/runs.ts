import type {
  ClaimTurnOptions,
  ClaimTurnResult,
  CreateTurnResult,
  TurnRecord,
  TurnStatus,
  TurnStore,
} from "../host/types";
import type { ExecutionState } from "./state";

const claimableStatuses = new Set<TurnStatus>([
  "leased",
  "queued",
  "running",
  "suspended",
]);

export class InMemoryRunStore implements TurnStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  create(record: TurnRecord): Promise<CreateTurnResult> {
    const state = this.#state();
    const existing =
      state.turns.get(record.runId) ?? existingDedupeRun(state, record);
    if (existing) {
      return Promise.resolve({
        ok: false,
        reason: "duplicate",
        record: structuredClone(existing),
      });
    }

    const stored = structuredClone(record);
    state.turns.set(record.runId, stored);
    return Promise.resolve({ ok: true, record: structuredClone(stored) });
  }

  get(runId: string): Promise<TurnRecord | null> {
    const record = this.#state().turns.get(runId);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  getByDedupeKey(dedupeKey: string): Promise<TurnRecord | null> {
    const record = [...this.#state().turns.values()].find(
      (candidate) => candidate.dedupeKey === dedupeKey
    );
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  listByParentRunId(parentRunId: string): Promise<readonly TurnRecord[]> {
    const records = [...this.#state().turns.values()].filter(
      (candidate) => candidate.parentRunId === parentRunId
    );
    return Promise.resolve(records.map((record) => structuredClone(record)));
  }

  update(record: TurnRecord): Promise<TurnRecord> {
    const stored = structuredClone(record);
    this.#state().turns.set(record.runId, stored);
    return Promise.resolve(structuredClone(stored));
  }

  claim(runId: string, options: ClaimTurnOptions): Promise<ClaimTurnResult> {
    const record = this.#state().turns.get(runId);
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
    const claimed: TurnRecord = {
      ...record,
      lease,
      status: "leased",
    };
    this.#state().turns.set(runId, claimed);
    return Promise.resolve({
      lease,
      ok: true,
      record: structuredClone(claimed),
    });
  }
}

function existingDedupeRun(
  state: ExecutionState,
  record: TurnRecord
): TurnRecord | undefined {
  return record.dedupeKey
    ? [...state.turns.values()].find(
        (candidate) => candidate.dedupeKey === record.dedupeKey
      )
    : undefined;
}
