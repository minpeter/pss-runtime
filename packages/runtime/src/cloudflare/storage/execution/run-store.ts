import type {
  ClaimRunOptions,
  ClaimRunResult,
  RunRecord,
  RunStatus,
  RunStore,
} from "../../../execution";
import type { CloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import {
  getRun,
  indexRun,
  putRun,
  readList,
  storeKey,
  withTransaction,
} from "./records";

const claimableStatuses = new Set<RunStatus>([
  "leased",
  "queued",
  "running",
  "suspended",
]);

export class DurableObjectRunStore implements RunStore {
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async claim(
    runId: string,
    options: ClaimRunOptions
  ): Promise<ClaimRunResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const run = await getRun(storage, this.#prefix, runId);
      if (!run) {
        return { ok: false, reason: "not-found" };
      }
      if (!claimableStatuses.has(run.status)) {
        return { ok: false, reason: "not-claimable" };
      }
      if (run.lease && run.lease.leaseUntilMs > options.nowMs) {
        return { ok: false, reason: "leased" };
      }

      const lease = {
        attempt: options.attempt,
        leaseId: options.leaseId,
        leaseUntilMs: options.nowMs + options.leaseMs,
      };
      const claimed: RunRecord = { ...run, lease, status: "leased" };
      await putRun(storage, this.#prefix, claimed);
      return { lease, ok: true, record: structuredClone(claimed) };
    });
  }

  async create(record: RunRecord): Promise<RunRecord> {
    return await withTransaction(this.#storage, async (storage) => {
      await putRun(storage, this.#prefix, record);
      await indexRun(storage, this.#prefix, record);
      return structuredClone(record);
    });
  }

  async get(runId: string): Promise<RunRecord | null> {
    return await getRun(this.#storage, this.#prefix, runId);
  }

  async getByDedupeKey(dedupeKey: string): Promise<RunRecord | null> {
    const runId = await this.#storage.get<string>(
      storeKey(this.#prefix, "run-dedupe", dedupeKey)
    );
    return runId ? await this.get(runId) : null;
  }

  async listByParentRunId(parentRunId: string): Promise<readonly RunRecord[]> {
    const runIds = await readList<string>(
      this.#storage,
      storeKey(this.#prefix, "run-parent", parentRunId)
    );
    const runs = await Promise.all(runIds.map((runId) => this.get(runId)));
    return runs.filter(isRunRecord);
  }

  async update(record: RunRecord): Promise<RunRecord> {
    return await withTransaction(this.#storage, async (storage) => {
      await putRun(storage, this.#prefix, record);
      await indexRun(storage, this.#prefix, record);
      return structuredClone(record);
    });
  }
}

function isRunRecord(record: RunRecord | null): record is RunRecord {
  return record !== null;
}
