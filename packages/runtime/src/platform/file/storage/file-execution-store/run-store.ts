import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applyTurnTransitionUpdate,
  decideTurnTransition,
  resolveTurnClaim,
} from "../../../../execution/host/turn-status";
import type {
  ClaimTurnOptions,
  ClaimTurnResult,
  CreateTurnResult,
  TurnRecord,
  TurnStatus,
  TurnStore,
  TurnTransitionExpected,
  TurnTransitionResult,
  TurnTransitionUpdate,
} from "../../../../execution/host/types";
import { isNodeError } from "../../../../internal/guards";
import { readJsonFile, writeJsonFile } from "./json";
import { parseRunRecord, runCreatedOrder } from "./schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

let lastCreatedOrder = 0;
function nextCreatedOrder(): number {
  lastCreatedOrder = Math.max(Date.now() * 1000, lastCreatedOrder + 1);
  return lastCreatedOrder;
}

/**
 * `createdOrder` reserved for runs written before creation order was
 * persisted. Their real order is unrecoverable (copies rewrote file times), so
 * the first read assigns this marker and every rewrite persists it: a legacy
 * run never moves after runs with a real (positive) creation order, whatever
 * its later status.
 */
const LEGACY_CREATED_ORDER = 0;

const SETTLED_STATUS: Record<TurnStatus, boolean> = {
  cancelled: true,
  completed: true,
  error: true,
  leased: false,
  "needs-recovery": true,
  queued: false,
  running: false,
  suspended: false,
};

async function readRunFile(file: string): Promise<TurnRecord | null> {
  const record = await readJsonFile(file, parseRunRecord, "run file");
  if (record && !runCreatedOrder.has(record)) {
    runCreatedOrder.set(record, LEGACY_CREATED_ORDER);
  }
  return record;
}

function compareRunCreation(left: TurnRecord, right: TurnRecord): number {
  const leftOrder = runCreatedOrder.get(left) ?? LEGACY_CREATED_ORDER;
  const rightOrder = runCreatedOrder.get(right) ?? LEGACY_CREATED_ORDER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  // Among legacy runs, settled ones sort after unsettled ones and are read as
  // the latest work, so recovery never resumes a stale crashed legacy run when
  // a later one finished. Placement follows the current status on purpose: a
  // recovered legacy run that settles becomes the latest legacy run.
  if (leftOrder === LEGACY_CREATED_ORDER) {
    const settledDelta =
      Number(SETTLED_STATUS[left.status]) -
      Number(SETTLED_STATUS[right.status]);
    if (settledDelta !== 0) {
      return settledDelta;
    }
  }
  if (left.runId === right.runId) {
    return 0;
  }
  return left.runId < right.runId ? -1 : 1;
}

export class FileRunStore implements TurnStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async claim(
    runId: string,
    options: ClaimTurnOptions
  ): Promise<ClaimTurnResult> {
    return await this.#lock(async () => {
      const record = await this.#getUnlocked(runId);
      if (!record) {
        return { ok: false, reason: "not-found" };
      }

      const { decision, nextRecord } = resolveTurnClaim(runId, record, options);
      if (nextRecord) {
        await this.#writeUnlocked(nextRecord, runCreatedOrder.get(record));
      }
      return decision;
    });
  }

  async create(record: TurnRecord): Promise<CreateTurnResult> {
    return await this.#lock(async () => {
      const existingById = await this.#getUnlocked(record.runId);
      if (existingById) {
        return { ok: false, reason: "duplicate", record: existingById };
      }

      if (record.dedupeKey) {
        const existingByDedupeKey = await this.#getByDedupeKeyUnlocked(
          record.dedupeKey
        );
        if (existingByDedupeKey) {
          return {
            ok: false,
            reason: "duplicate",
            record: existingByDedupeKey,
          };
        }
      }

      await this.#writeUnlocked(record, nextCreatedOrder());
      return { ok: true, record };
    });
  }

  async get(runId: string): Promise<TurnRecord | null> {
    return await this.#lock(async () => await this.#getUnlocked(runId));
  }

  async getByDedupeKey(dedupeKey: string): Promise<TurnRecord | null> {
    return await this.#lock(
      async () => await this.#getByDedupeKeyUnlocked(dedupeKey)
    );
  }

  listByParentRunId(parentRunId: string): Promise<readonly TurnRecord[]> {
    return this.#filterUnlocked((record) => record.parentRunId === parentRunId);
  }

  listByThreadKey(threadKey: string): Promise<readonly TurnRecord[]> {
    return this.#filterUnlocked((record) => record.threadKey === threadKey);
  }

  async #filterUnlocked(
    predicate: (record: TurnRecord) => boolean
  ): Promise<readonly TurnRecord[]> {
    return await this.#lock(async () =>
      (await this.#listUnlocked()).filter(predicate)
    );
  }

  async transition(
    runId: string,
    expected: TurnTransitionExpected,
    update: TurnTransitionUpdate
  ): Promise<TurnTransitionResult> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(runId);
      if (!current) {
        return { ok: false, reason: "not-found" };
      }
      const conflict = decideTurnTransition(runId, current, expected);
      if (conflict) {
        return conflict;
      }
      const record = applyTurnTransitionUpdate(current, update);
      await this.#writeUnlocked(record, runCreatedOrder.get(current));
      return { ok: true, record: structuredClone(record) };
    });
  }

  async update(record: TurnRecord): Promise<TurnRecord> {
    return await this.#lock(async () => {
      const existing = await this.#getUnlocked(record.runId);
      await this.#writeUnlocked(
        record,
        existing ? runCreatedOrder.get(existing) : nextCreatedOrder()
      );
      return record;
    });
  }

  async updateCheckpointVersion(
    runId: string,
    checkpointVersion: number
  ): Promise<void> {
    const record = await this.#getUnlocked(runId);
    if (!record) {
      return;
    }
    await this.#writeUnlocked(
      { ...record, checkpointVersion },
      runCreatedOrder.get(record)
    );
  }

  getUnlocked(runId: string): Promise<TurnRecord | null> {
    return this.#getUnlocked(runId);
  }

  async #getByDedupeKeyUnlocked(dedupeKey: string): Promise<TurnRecord | null> {
    const records = await this.#listUnlocked();
    return records.find((record) => record.dedupeKey === dedupeKey) ?? null;
  }

  async #getUnlocked(runId: string): Promise<TurnRecord | null> {
    return await readRunFile(await this.#fileForRun(runId));
  }

  async #listUnlocked(): Promise<readonly TurnRecord[]> {
    const directory = join(await this.#directory(), "runs");
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const records: TurnRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const record = await readRunFile(join(directory, entry));
      if (record) {
        records.push(record);
      }
    }
    return records.sort(compareRunCreation);
  }

  async #writeUnlocked(
    record: TurnRecord,
    createdOrder?: number
  ): Promise<void> {
    await writeJsonFile(
      await this.#fileForRun(record.runId),
      createdOrder === undefined ? record : { ...record, createdOrder }
    );
  }

  async #fileForRun(runId: string): Promise<string> {
    return join(await this.#directory(), "runs", `${encodeKey(runId)}.json`);
  }
}
