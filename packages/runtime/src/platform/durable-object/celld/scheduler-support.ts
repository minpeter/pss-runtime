import {
  isScheduledThreadPrompt,
  type ScheduledThreadPrompt,
} from "../../../execution/scheduled-work";
import type {
  DurableObjectStorage,
  DurableObjectTransactionalScheduler,
  DurableObjectTransactionStorage,
} from "../host/storage-host";
import { withTransaction } from "../storage/durable-object/sql-access";
import {
  insertScheduledWorkInTransaction,
  selectNextScheduledWork,
  selectScheduledWorkDue,
} from "../storage/sqlite/scheduled-work-table";

export const DEFAULT_PREFIX = "pss-runtime";
export const RUN_KIND = "celld-run";
export const THREAD_PROMPT_KIND = "celld-thread-prompt";
export const storageOperations = new WeakMap<object, Promise<void>>();

export interface CelldScheduledWorkListOptions {
  readonly limit?: number;
  readonly nowMs?: number;
  readonly prefix?: string;
}

export interface CelldSchedulerOptions {
  readonly clock?: () => number;
  readonly prefix?: string;
  readonly storage: CelldDurableObjectStorage;
}

export interface CelldScheduler extends DurableObjectTransactionalScheduler {
  readonly storage: CelldDurableObjectStorage;
}

export interface CelldDurableObjectStorage extends DurableObjectStorage {
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: Date | number): Promise<void>;
  transaction<T>(
    fn: (storage: DurableObjectTransactionStorage) => Promise<T>
  ): Promise<T>;
}

interface DuePayload<T> {
  readonly dueAtMs: number;
  readonly value: T;
}

export function serialize<T>(
  storage: CelldDurableObjectStorage,
  operation: () => Promise<T>
): Promise<T> {
  const previous = storageOperations.get(storage) ?? Promise.resolve();
  const current = previous.then(operation);
  storageOperations.set(
    storage,
    current.then(
      () => undefined,
      () => undefined
    )
  );
  return current;
}

export async function insertDueWorkInTransaction<T>(
  transaction: DurableObjectTransactionStorage,
  storage: CelldDurableObjectStorage,
  prefix: string,
  kind: typeof RUN_KIND | typeof THREAD_PROMPT_KIND,
  workId: string,
  value: T,
  dueAtMs: number,
  indexes: { readonly runId?: string; readonly threadKey?: string }
): Promise<void> {
  if (transaction.setAlarm === undefined) {
    throw new Error("Celld storage transaction setAlarm() is required.");
  }
  insertScheduledWorkInTransaction(
    transaction,
    prefix,
    kind,
    workId,
    { dueAtMs, value } satisfies DuePayload<T>,
    { ...indexes, dueAtMs }
  );
  const nextDueAtMs = earliestDueAt(transaction, prefix);
  // Only a preserved duplicate that predates due_at leaves nothing to arm.
  if (nextDueAtMs === undefined) {
    return;
  }
  // An earlier alarm may belong to work outside this prefix, so it is kept.
  const currentAlarm = await (transaction.getAlarm?.() ?? storage.getAlarm());
  await transaction.setAlarm(
    Math.min(currentAlarm ?? Number.POSITIVE_INFINITY, nextDueAtMs)
  );
}

export async function insertDueWorkAndArm<T>(
  storage: CelldDurableObjectStorage,
  prefix: string,
  kind: typeof RUN_KIND | typeof THREAD_PROMPT_KIND,
  workId: string,
  value: T,
  dueAtMs: number,
  indexes: { readonly runId?: string; readonly threadKey?: string }
): Promise<void> {
  await withTransaction(storage, (tx) =>
    insertDueWorkInTransaction(
      tx,
      storage,
      prefix,
      kind,
      workId,
      value,
      dueAtMs,
      indexes
    )
  );
}

export function listDueWork<T>(
  storage: CelldDurableObjectStorage,
  kind: typeof RUN_KIND | typeof THREAD_PROMPT_KIND,
  options: CelldScheduledWorkListOptions,
  parseValue: (value: unknown) => T | undefined
): T[] {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const nowMs = options.nowMs ?? Date.now();
  const limit = normalizeLimit(options.limit);
  if (limit === 0) {
    return [];
  }
  return selectScheduledWorkDue(storage, prefix, kind, nowMs, limit)
    .map((row) => requiredDuePayload(row.payload))
    .flatMap((value) => {
      const parsed = parseValue(value.value);
      if (parsed === undefined) {
        throw new Error("Invalid Celld scheduled work value.");
      }
      return [parsed];
    });
}

/**
 * Applies `mutate` to scheduled-work rows and re-arms the alarm for the
 * earliest persisted due time in one storage transaction, so the alarm never
 * reflects rows another transaction has since changed. A transaction without
 * setAlarm gets the storage-level write after commit: written inside, it would
 * be replaced by the transaction's buffered alarm. A transaction without
 * deleteAlarm leaves the alarm in place: deleting after commit could erase an
 * alarm a concurrent transaction just armed, while a stale alarm only costs
 * one empty drain, which re-arms.
 */
export async function armNextAlarm(
  storage: CelldDurableObjectStorage,
  prefix: string,
  mutate?: (transaction: DurableObjectTransactionStorage) => Promise<void>
): Promise<void> {
  const afterCommit = await withTransaction(
    storage,
    async (transaction): Promise<(() => Promise<void>) | undefined> => {
      await mutate?.(transaction);
      const dueAtMs = earliestDueAt(transaction, prefix);
      if (dueAtMs === undefined) {
        await transaction.deleteAlarm?.();
        return;
      }
      if (transaction.setAlarm === undefined) {
        return async () => {
          if ((await storage.getAlarm()) !== dueAtMs) {
            await storage.setAlarm(dueAtMs);
          }
        };
      }
      if ((await transaction.getAlarm?.()) !== dueAtMs) {
        await transaction.setAlarm(dueAtMs);
      }
    }
  );
  await afterCommit?.();
}

function earliestDueAt(
  transaction: DurableObjectTransactionStorage,
  prefix: string
): number | undefined {
  const values = ([RUN_KIND, THREAD_PROMPT_KIND] as const).flatMap((kind) => {
    const row = selectNextScheduledWork(transaction, prefix, kind);
    return typeof row?.due_at === "number" ? [row.due_at] : [];
  });
  return values.length === 0 ? undefined : Math.min(...values);
}

function parseDuePayload(payload: string): DuePayload<unknown> | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value === "object" &&
      value !== null &&
      "dueAtMs" in value &&
      typeof value.dueAtMs === "number" &&
      Number.isFinite(value.dueAtMs) &&
      "value" in value
    ) {
      return { dueAtMs: value.dueAtMs, value: value.value };
    }
  } catch {
    return;
  }
}

function requiredDuePayload(payload: string): DuePayload<unknown> {
  const value = parseDuePayload(payload);
  if (value === undefined) {
    throw new Error("Invalid Celld scheduled work payload.");
  }
  return value;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
}

export function parseThreadPrompt(
  value: unknown
): ScheduledThreadPrompt | undefined {
  return isScheduledThreadPrompt(value) ? value : undefined;
}
