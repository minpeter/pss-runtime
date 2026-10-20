import type { ScheduledThreadPrompt } from "../../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../../execution/scheduled-work";
import type { DurableObjectTransactionStorage } from "../storage/durable-object/durable-object-storage";
import { withTransaction } from "../storage/durable-object/sql-access";
import {
  ackScheduledWorkLease,
  claimScheduledWorkLease,
  releaseScheduledWorkLease,
} from "../storage/sqlite/scheduled-work-claims";
import { deleteScheduledWork } from "../storage/sqlite/scheduled-work-table";
import type {
  CelldDurableObjectStorage,
  CelldScheduledWorkKind,
} from "./scheduler-support";
import {
  armNextAlarm,
  BACKSTOP_KIND,
  DEFAULT_PREFIX,
  insertDueWorkAndArm,
  RUN_KIND,
  serialize,
  THREAD_PROMPT_KIND,
} from "./scheduler-support";

interface ClaimOptions {
  readonly leaseMs?: number;
  readonly nowMs?: number;
  readonly prefix?: string;
}

interface MutationOptions {
  readonly claimToken?: string;
  readonly nowMs?: number;
  readonly prefix?: string;
  readonly rearm?: boolean;
}

export function claimCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: ClaimOptions = {}
): Promise<string | undefined> {
  return serialize(storage, () =>
    claimScheduledWorkLease(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      RUN_KIND,
      runId,
      options.nowMs,
      options.leaseMs
    )
  );
}

export function claimCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: ClaimOptions = {}
): Promise<string | undefined> {
  return serialize(storage, () =>
    claimScheduledWorkLease(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      THREAD_PROMPT_KIND,
      threadPromptScheduledWorkId(prompt),
      options.nowMs,
      options.leaseMs
    )
  );
}

export function rearmCelldScheduledWork(
  storage: CelldDurableObjectStorage,
  options: ClaimOptions = {}
): Promise<void> {
  return serialize(storage, () =>
    armNextAlarm(storage, options.prefix ?? DEFAULT_PREFIX)
  );
}

export function retryCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  delayMs: number,
  options: MutationOptions = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const nowMs = options.nowMs ?? Date.now();
  return serialize(storage, async () => {
    if (options.claimToken === undefined) {
      await insertDueWorkAndArm(
        storage,
        prefix,
        RUN_KIND,
        runId,
        runId,
        nowMs + Math.max(0, Math.floor(delayMs)),
        { runId }
      );
    } else {
      await releaseScheduledWorkLease(
        storage,
        prefix,
        RUN_KIND,
        runId,
        options.claimToken,
        nowMs + Math.max(0, Math.floor(delayMs))
      );
    }
    await armNextAlarm(storage, prefix);
  });
}

export function retryCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: MutationOptions = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const nowMs = options.nowMs ?? Date.now();
  return serialize(storage, async () => {
    if (options.claimToken === undefined) {
      await insertDueWorkAndArm(
        storage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt),
        prompt,
        nowMs,
        { runId: prompt.runId, threadKey: prompt.threadKey }
      );
    } else {
      await releaseScheduledWorkLease(
        storage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt),
        options.claimToken,
        nowMs
      );
    }
    await armNextAlarm(storage, prefix);
  });
}

export async function ackCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: MutationOptions = {}
): Promise<void> {
  await ackScheduledWork(storage, RUN_KIND, runId, options);
}

export async function ackCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: MutationOptions = {}
): Promise<void> {
  await ackScheduledWork(
    storage,
    THREAD_PROMPT_KIND,
    threadPromptScheduledWorkId(prompt),
    options
  );
}

export function claimCelldScheduledBackstop(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: ClaimOptions = {}
): Promise<string | undefined> {
  return serialize(storage, () =>
    claimScheduledWorkLease(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      BACKSTOP_KIND,
      runId,
      options.nowMs,
      options.leaseMs
    )
  );
}

/** Moves a claimed backstop `delayMs` later; a replaced claim is left alone. */
export function retryCelldScheduledBackstop(
  storage: CelldDurableObjectStorage,
  runId: string,
  delayMs: number,
  options: MutationOptions & { readonly claimToken: string }
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const nowMs = options.nowMs ?? Date.now();
  return serialize(storage, async () => {
    await releaseScheduledWorkLease(
      storage,
      prefix,
      BACKSTOP_KIND,
      runId,
      options.claimToken,
      nowMs + Math.max(0, Math.floor(delayMs))
    );
    await armNextAlarm(storage, prefix);
  });
}

export async function ackCelldScheduledBackstop(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: MutationOptions = {}
): Promise<void> {
  await ackScheduledWork(storage, BACKSTOP_KIND, runId, options);
}

function ackScheduledWork(
  storage: CelldDurableObjectStorage,
  kind: CelldScheduledWorkKind,
  workId: string,
  options: MutationOptions
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  return serialize(storage, async () => {
    if (options.claimToken !== undefined) {
      await ackScheduledWorkLease(
        storage,
        prefix,
        kind,
        workId,
        options.claimToken
      );
      if (options.rearm !== false) {
        await armNextAlarm(storage, prefix);
      }
      return;
    }
    // The delete must run in its own storage transaction: issued directly it
    // would join, and roll back with, any store transaction open on the
    // same SQL connection.
    const deleteRow = (transaction: DurableObjectTransactionStorage) =>
      deleteScheduledWork(transaction, prefix, kind, workId);
    await (options.rearm === false
      ? withTransaction(storage, deleteRow)
      : armNextAlarm(storage, prefix, deleteRow));
  });
}
