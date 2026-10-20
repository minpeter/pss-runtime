import type { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { TURN_BACKSTOP_DELAY_MS } from "../../execution/dispatch/turn-backstop";
import {
  processLeaseOwner,
  TURN_LEASE_MS,
} from "../../execution/host/lease-owner";
import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import { transitionTurn } from "../../execution/host/turn-status";
import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";
import type {
  AgentHost,
  TurnKind,
  TurnLease,
  TurnRecord,
  TurnStatus,
  TurnStore,
} from "../../execution/host/types";
import type { ThreadState } from "../state/thread-state";
import type { CommitResult } from "../store/types";
import type { AgentCompaction } from "./auto-compaction-types";
import {
  createThreadToolExecutionContext,
  type ThreadToolCallInterceptor,
  type ThreadToolExecutionContext,
  type ThreadToolResultInterceptor,
} from "./execution-checkpoints";
import {
  commitOwnedThreadExecutionRunStorage,
  completeThreadExecutionRun,
  isTerminalTurnStatus,
  type OwnedRunStorageCommit,
  settleThreadExecutionRun,
  type TerminalRunStorageCommit,
} from "./terminal-run-settlement";
import { startTurnLeaseHeartbeat } from "./turn-ownership";

export interface ThreadExecutionOptions {
  readonly compaction?: AgentCompaction;
  readonly executionHost?: AgentHost;
  readonly hookRuntime?: AgentHookRuntime;
  readonly ownerNamespace?: string;
}

export interface QueuedThreadExecutionRun {
  readonly kind: TurnKind;
  readonly leaseId?: string | null;
  readonly runId: string;
}

export type ThreadExecutionCancellation =
  | {
      readonly kind: "owned";
      readonly leaseId: string | null;
      readonly runId: string;
    }
  | { readonly kind: "unleased"; readonly runId: string };

export interface ThreadExecutionRun {
  commitOwned<Result>(persist: OwnedRunStorageCommit<Result>): Promise<Result>;
  complete(status: ThreadExecutionTerminalStatus): Promise<void>;
  /** Aborted with a `TurnOwnershipLostError` when another owner took over. */
  readonly ownershipLost: AbortSignal;
  /** Stops renewing the run's lease; settling the run also stops it. */
  release(): void;
  readonly runId: string;
  settle(
    status: ThreadExecutionTerminalStatus,
    persist: TerminalRunStorageCommit
  ): Promise<CommitResult>;
  readonly toolExecution: ThreadToolExecutionContext;
}

export type ThreadExecutionTerminalStatus = Extract<
  TurnStatus,
  "cancelled" | "completed" | "error" | "needs-recovery"
>;

export async function precreateThreadExecutionRun({
  executionHost,
  kind,
  ownerNamespace,
  runId: requestedRunId,
  threadKey,
  turnStore,
}: {
  readonly executionHost?: AgentHost;
  readonly kind: TurnKind;
  readonly ownerNamespace?: string;
  readonly runId?: string;
  readonly threadKey: string;
  readonly turnStore?: TurnStore;
}): Promise<TurnRecord | undefined> {
  const turns = turnStore ?? executionHost?.store.turns;
  if (!turns) {
    return;
  }

  const runId =
    requestedRunId ??
    createThreadExecutionRunId({
      threadKey,
      turnId: crypto.randomUUID(),
    });
  const created = await turns.create(
    createThreadExecutionRunRecord({
      kind,
      ownerNamespace,
      runId,
      status: "queued",
      threadKey,
    })
  );
  return created.record;
}

export async function startThreadExecutionRun({
  executionRun,
  executionHost,
  interceptToolCall,
  interceptToolResult,
  ownerNamespace,
  threadKey,
  state,
  turnId,
}: {
  readonly executionRun?: QueuedThreadExecutionRun;
  readonly executionHost?: AgentHost;
  readonly interceptToolCall?: ThreadToolCallInterceptor;
  readonly interceptToolResult?: ThreadToolResultInterceptor;
  readonly ownerNamespace?: string;
  readonly threadKey: string;
  readonly state: ThreadState;
  readonly turnId: string;
}): Promise<ThreadExecutionRun | undefined> {
  if (!executionHost) {
    return;
  }

  const runId =
    executionRun?.runId ?? createThreadExecutionRunId({ threadKey, turnId });
  const start = (turns: TurnStore) =>
    markRunRunning({
      executionHost,
      executionRun,
      ownerNamespace,
      runId,
      threadKey,
      turns,
    });
  const running = await startWithBackstop(
    executionHost,
    { runId, threadKey },
    start
  );

  const leaseId = running.lease?.leaseId ?? null;
  const heartbeat = running.lease
    ? startTurnLeaseHeartbeat({
        lease: running.lease,
        runId,
        store: executionHost.store,
      })
    : undefined;
  // Renewal stops before settlement writes; the lease counts as this
  // process's until settlement finishes, so no claim here races it.
  const settling = async <Result>(
    write: () => Promise<Result>
  ): Promise<Result> => {
    heartbeat?.stopRenewal();
    try {
      return await write();
    } finally {
      heartbeat?.release();
    }
  };
  return {
    commitOwned: async (persist) =>
      await commitOwnedThreadExecutionRunStorage({
        executionHost,
        leaseId,
        persist,
        runId,
      }),
    complete: (status) =>
      settling(() =>
        completeThreadExecutionRun({
          executionHost,
          leaseId,
          runId,
          status,
        })
      ),
    ownershipLost: heartbeat?.lost ?? new AbortController().signal,
    release: () => heartbeat?.release(),
    runId,
    settle: (status, persist) =>
      settling(() =>
        settleThreadExecutionRun({
          executionHost,
          leaseId,
          persist,
          runId,
          status,
        })
      ),
    toolExecution: createThreadToolExecutionContext({
      executionHost,
      interceptToolCall,
      interceptToolResult,
      leaseId,
      runId,
      state,
    }),
  };
}

/**
 * Makes the run `running` under a fresh lease, or the lease its claim took,
 * so no other process can take a live turn over; the heartbeat keeps the
 * lease current.
 */
async function markRunRunning({
  executionHost,
  executionRun,
  ownerNamespace,
  runId,
  threadKey,
  turns,
}: {
  readonly executionHost: AgentHost;
  readonly executionRun?: QueuedThreadExecutionRun;
  readonly ownerNamespace?: string;
  readonly runId: string;
  readonly threadKey: string;
  readonly turns: TurnStore;
}): Promise<TurnRecord> {
  const owner = processLeaseOwner(executionHost.ownerLiveness);
  const startLease = (claimed: TurnLease | undefined): TurnLease => ({
    attempt: claimed?.attempt ?? 1,
    leaseId: claimed?.leaseId ?? crypto.randomUUID(),
    leaseUntilMs: Date.now() + TURN_LEASE_MS,
    owner,
  });
  const created = await turns.create({
    ...createThreadExecutionRunRecord({
      kind: executionRun?.kind ?? "user-turn",
      ownerNamespace,
      runId,
      status: "running",
      threadKey,
    }),
    lease: startLease(undefined),
  });
  if (isTerminalTurnStatus(created.record.status)) {
    throw new TurnTransitionConflictError(runId, "start", "status-conflict");
  }
  if (created.ok) {
    return created.record;
  }
  const expectedLeaseId = executionRun?.leaseId ?? null;
  const transition = await transitionTurn(turns, {
    expected: { leaseId: expectedLeaseId, status: created.record.status },
    runId,
    update: {
      lease: startLease(
        expectedLeaseId === null ? undefined : created.record.lease
      ),
      status: "running",
    },
  });
  if (!transition.ok) {
    throw new TurnTransitionConflictError(runId, "start", transition.reason);
  }
  return transition.record;
}

/**
 * Starts the run and, on hosts that schedule backstops, schedules its first
 * one in the same transaction, so a crash right after the start still gets
 * the run checked. A host whose transactions cannot schedule does it next.
 */
async function startWithBackstop(
  executionHost: AgentHost,
  { runId, threadKey }: { readonly runId: string; readonly threadKey: string },
  start: (turns: TurnStore) => Promise<TurnRecord>
): Promise<TurnRecord> {
  if (!executionHost.scheduler.scheduleBackstop) {
    return await start(executionHost.store.turns);
  }
  const backstop = { runAfterMs: TURN_BACKSTOP_DELAY_MS, threadKey };
  const started = await executionHost.store.transaction(async (tx) => {
    const record = await start(tx.turns);
    const scheduled = tx.scheduler?.scheduleBackstop;
    await scheduled?.call(tx.scheduler, runId, backstop);
    return { record, scheduled: scheduled !== undefined };
  });
  if (!started.scheduled) {
    await executionHost.scheduler.scheduleBackstop(runId, backstop);
  }
  return started.record;
}

export function cancellationForExecutionRun(
  executionRun: QueuedThreadExecutionRun | undefined
): ThreadExecutionCancellation | undefined {
  if (!executionRun) {
    return;
  }
  return {
    kind: "owned",
    leaseId: executionRun.leaseId ?? null,
    runId: executionRun.runId,
  };
}

export async function cancelThreadExecutionRun({
  cancellation,
  executionHost,
}: {
  readonly cancellation: ThreadExecutionCancellation | undefined;
  readonly executionHost?: AgentHost;
}): Promise<void> {
  if (!(executionHost && cancellation)) {
    return;
  }

  const run = await executionHost.store.turns.get(cancellation.runId);
  if (!run || isTerminalTurnStatus(run.status)) {
    return;
  }
  const transition = await transitionTurn(executionHost.store.turns, {
    expected: {
      leaseId: cancellation.kind === "owned" ? cancellation.leaseId : null,
      status: run.status,
    },
    runId: cancellation.runId,
    update: { status: "cancelled" },
  });
  if (!transition.ok) {
    if (transition.reason === "lease-conflict") {
      return;
    }
    const current =
      transition.reason === "status-conflict"
        ? await executionHost.store.turns.get(cancellation.runId)
        : undefined;
    if (current && isTerminalTurnStatus(current.status)) {
      return;
    }
    throw new TurnTransitionConflictError(
      cancellation.runId,
      "cancel",
      transition.reason
    );
  }
}

export function createThreadExecutionRunRecord({
  kind,
  ownerNamespace,
  runId,
  status,
  threadKey,
}: {
  readonly kind: TurnKind;
  readonly ownerNamespace?: string;
  readonly runId: string;
  readonly status: Extract<TurnStatus, "queued" | "running">;
  readonly threadKey: string;
}): TurnRecord {
  return {
    checkpointVersion: 0,
    dedupeKey: runId,
    kind,
    ...(ownerNamespace === undefined ? {} : { ownerNamespace }),
    rootRunId: runId,
    runId,
    threadKey,
    status,
  };
}
