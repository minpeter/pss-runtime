import type { HostScheduler } from "../../../execution";
import type { ScheduledThreadPrompt } from "../../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../../execution/scheduled-work";
import type { DurableObjectTransactionStorage } from "../host/storage-host";
import { withTransaction } from "../storage/durable-object/sql-access";
import type {
  CelldDurableObjectStorage,
  CelldScheduledWorkListOptions,
  CelldScheduler,
  CelldSchedulerOptions,
} from "./scheduler-support";
import {
  DEFAULT_PREFIX,
  insertDueWorkInTransaction,
  listDueWork,
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
    transactionStorage: DurableObjectTransactionStorage,
    currentAlarm?: number | null
  ): HostScheduler => ({
    enqueueRun: async (runId, options = {}) => {
      await insertDueWorkInTransaction(
        transactionStorage,
        prefix,
        RUN_KIND,
        runId,
        runId,
        clock() + Math.max(0, Math.floor(options.runAfterMs ?? 0)),
        { runId },
        currentAlarm ?? (await storage.getAlarm())
      );
    },
    resumeThread: async (threadKey, options) => {
      const prompt: ScheduledThreadPrompt = {
        idempotencyKey: options.idempotencyKey,
        notificationId: options.notificationId,
        runId: options.runId,
        threadKey,
      };
      await insertDueWorkInTransaction(
        transactionStorage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt),
        prompt,
        clock(),
        { runId: options.runId, threadKey },
        currentAlarm ?? (await storage.getAlarm())
      );
    },
  });
  return {
    createTransactionScheduler,
    enqueueRun: (runId, options = {}) =>
      serialize(storage, async () => {
        const currentAlarm = await storage.getAlarm();
        await withTransaction(storage, (tx) =>
          createTransactionScheduler(tx, currentAlarm).enqueueRun(
            runId,
            options
          )
        );
      }),
    resumeThread: (threadKey, options) =>
      serialize(storage, async () => {
        const currentAlarm = await storage.getAlarm();
        await withTransaction(storage, (tx) =>
          createTransactionScheduler(tx, currentAlarm).resumeThread(
            threadKey,
            options
          )
        );
      }),
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
