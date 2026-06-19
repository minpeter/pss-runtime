import type {
  ClaimRunOptions,
  ClaimRunResult,
  CreateRunResult,
  RunRecord,
  RunStatus,
  RunStore,
} from "../host/types";
import type { ExecutionState } from "./state";

const claimableStatuses = new Set<RunStatus>([
  "leased",
  "queued",
  "running",
  "suspended",
]);

export class InMemoryRunStore implements RunStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  create(record: RunRecord): Promise<CreateRunResult> {
    const state = this.#state();
    const existing =
      state.runs.get(record.runId) ?? existingDedupeRun(state, record);
    if (existing) {
      return Promise.resolve({
        ok: false,
        reason: "duplicate",
        record: structuredClone(existing),
      });
    }

    const stored = structuredClone(record);
    state.runs.set(record.runId, stored);
    return Promise.resolve({ ok: true, record: structuredClone(stored) });
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

function existingDedupeRun(
  state: ExecutionState,
  record: RunRecord
): RunRecord | undefined {
  return record.dedupeKey
    ? [...state.runs.values()].find(
        (candidate) => candidate.dedupeKey === record.dedupeKey
      )
    : undefined;
}
