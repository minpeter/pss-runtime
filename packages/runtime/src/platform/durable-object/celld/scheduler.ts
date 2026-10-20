import type { HostScheduler } from "../../../execution";
import type { ScheduledThreadPrompt } from "../../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../../execution/scheduled-work";
import type { DurableObjectTransactionStorage } from "../host/storage-host";
import { withTransaction } from "../storage/durable-object/sql-access";
import { deleteScheduledWork } from "../storage/sqlite/scheduled-work-table";
import type {
  CelldDurableObjectStorage,
  CelldScheduledBackstop,
  CelldScheduledWorkListOptions,
  CelldScheduler,
  CelldSchedulerOptions,
} from "./scheduler-support";
import {
  BACKSTOP_KIND,
  DEFAULT_PREFIX,
  insertDueWorkInTransaction,
  listDueWork,
  parseBackstop,
  parseThreadPrompt,
  RUN_KIND,
  serialize,
  THREAD_PROMPT_KIND,
} from "./scheduler-support";

export function createCelldScheduler({
  clock = Date.now,
  prefix = DEFAULT_PREFIX,
  storage,
}: CelldSchedulerOptions): CelldScheduler {
  const createTransactionScheduler = (
    transactionStorage: DurableObjectTransactionStorage
  ): HostScheduler => ({
    // A stale alarm left behind costs one empty drain, which re-arms.
    cancelBackstop: (runId) =>
      deleteScheduledWork(transactionStorage, prefix, BACKSTOP_KIND, runId),
    enqueueRun: (runId, options = {}) =>
      insertDueWorkInTransaction(
        transactionStorage,
        storage,
        prefix,
        RUN_KIND,
        runId,
        runId,
        clock() + Math.max(0, Math.floor(options.runAfterMs ?? 0)),
        { runId }
      ),
    resumeThread: (threadKey, options) => {
      const prompt: ScheduledThreadPrompt = {
        idempotencyKey: options.idempotencyKey,
        notificationId: options.notificationId,
        runId: options.runId,
        threadKey,
      };
      return insertDueWorkInTransaction(
        transactionStorage,
        storage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt),
        prompt,
        clock(),
        { runId: options.runId, threadKey }
      );
    },
    scheduleBackstop: async (runId, { runAfterMs, threadKey }) => {
      // A later check replaces the run's earlier one, claimed or not.
      await deleteScheduledWork(
        transactionStorage,
        prefix,
        BACKSTOP_KIND,
        runId
      );
      await insertDueWorkInTransaction(
        transactionStorage,
        storage,
        prefix,
        BACKSTOP_KIND,
        runId,
        { runId, threadKey } satisfies CelldScheduledBackstop,
        clock() + Math.max(0, Math.floor(runAfterMs)),
        { runId, threadKey }
      );
    },
  });
  const inTransaction = <T>(
    operation: (scheduler: HostScheduler) => Promise<T>
  ): Promise<T> =>
    serialize(storage, () =>
      withTransaction(storage, (tx) =>
        operation(createTransactionScheduler(tx))
      )
    );
  return {
    cancelBackstop: (runId) =>
      inTransaction((scheduler) => scheduler.cancelBackstop?.(runId) ?? none()),
    createTransactionScheduler,
    enqueueRun: (runId, options) =>
      inTransaction((scheduler) => scheduler.enqueueRun(runId, options)),
    resumeThread: (threadKey, options) =>
      inTransaction((scheduler) => scheduler.resumeThread(threadKey, options)),
    scheduleBackstop: (runId, options) =>
      inTransaction(
        (scheduler) => scheduler.scheduleBackstop?.(runId, options) ?? none()
      ),
    storage,
  };
}

export function listCelldScheduledRuns(
  storage: CelldDurableObjectStorage,
  options: CelldScheduledWorkListOptions = {}
): Promise<readonly string[]> {
  return Promise.resolve().then(() =>
    listDueWork(storage, RUN_KIND, options, (value) =>
      typeof value === "string" ? value : undefined
    )
  );
}

export function listCelldScheduledThreadPrompts(
  storage: CelldDurableObjectStorage,
  options: CelldScheduledWorkListOptions = {}
): Promise<readonly ScheduledThreadPrompt[]> {
  return Promise.resolve().then(() =>
    listDueWork(storage, THREAD_PROMPT_KIND, options, parseThreadPrompt)
  );
}

/** Due backstops, oldest first. */
export function listCelldScheduledBackstops(
  storage: CelldDurableObjectStorage,
  options: CelldScheduledWorkListOptions = {}
): Promise<readonly CelldScheduledBackstop[]> {
  return Promise.resolve().then(() =>
    listDueWork(storage, BACKSTOP_KIND, options, parseBackstop)
  );
}

function none(): Promise<void> {
  return Promise.resolve();
}
