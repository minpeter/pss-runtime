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
        existing ? runCreatedOrder.get(existing) : undefined
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
    return await readJsonFile(
      await this.#fileForRun(runId),
      parseRunRecord,
      "run file"
    );
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
      const record = await readJsonFile(
        join(directory, entry),
        parseRunRecord,
        "run file"
      );
      if (record) {
        records.push(record);
      }
    }
    return records.sort(
      (left, right) =>
        (runCreatedOrder.get(left) ?? 0) - (runCreatedOrder.get(right) ?? 0)
    );
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
