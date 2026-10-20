import {
  holdRunningLease,
  TURN_LEASE_MS,
  TURN_LEASE_RENEW_MS,
} from "../../execution/host/lease-owner";
import { transitionTurn } from "../../execution/host/turn-status";
import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";
import type { HostStore, TurnLease } from "../../execution/host/types";
import { closeRuntimeInput } from "../input/runtime-input";
import type { ThreadState } from "../state/thread-state";
import { restoreContextTokenMeter } from "./context-token-meter-rollback";
import { ThreadExecutionCheckpointAuthorityError } from "./execution-checkpoints";
import type { ProcessQueuedInputOptions } from "./turn-processor-options";
import { unrefTimer } from "./unref-timer";

export type TurnOwnershipLossReason =
  | "lease-conflict"
  | "not-found"
  | "status-conflict";

/** Another owner replaced the run's lease, settled it, or deleted it. */
export class TurnOwnershipLostError extends Error {
  readonly code = "THREAD_OWNERSHIP_LOST";
  readonly reason: TurnOwnershipLossReason;
  readonly runId: string;

  constructor(runId: string, reason: TurnOwnershipLossReason) {
    super(
      `Thread execution run ${runId} is no longer owned by this process (${reason}).`
    );
    this.name = "TurnOwnershipLostError";
    this.reason = reason;
    this.runId = runId;
  }
}

/** Renews a running turn's lease until stopped or lost. */
export interface TurnLeaseHeartbeat {
  /** Aborted with a `TurnOwnershipLostError` once the lease is lost. */
  readonly lost: AbortSignal;
  /** Stops renewing and lets this process's claims treat the run as left. */
  release(): void;
  /** Stops renewing; the run still counts as running in this process. */
  stopRenewal(): void;
}

/**
 * Renews `lease` every `renewMs` with a compare-and-swap on its id and the
 * `running` status; a failed swap means another owner took the run over.
 * Stores without an atomic `transition` renew inside a transaction, so the
 * read and write cannot undo a concurrent checkpoint write. Store errors are
 * retried on the next tick; the lease deadline still bounds a silent owner.
 */
export function startTurnLeaseHeartbeat({
  lease,
  leaseMs = TURN_LEASE_MS,
  renewMs = TURN_LEASE_RENEW_MS,
  runId,
  store,
}: {
  readonly lease: TurnLease;
  readonly leaseMs?: number;
  readonly renewMs?: number;
  readonly runId: string;
  readonly store: HostStore;
}): TurnLeaseHeartbeat {
  const controller = new AbortController();
  const releaseLease = holdRunningLease(lease.leaseId);
  let current = lease;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      renew().catch(() => undefined);
    }, renewMs);
    // A pending renewal must not keep a finished process alive.
    unrefTimer(timer);
  };
  const renew = async (): Promise<void> => {
    const next = { ...current, leaseUntilMs: Date.now() + leaseMs };
    const renewal = {
      expected: { leaseId: current.leaseId, status: "running" as const },
      runId,
      update: { lease: next, status: "running" as const },
    };
    let result: Awaited<ReturnType<typeof transitionTurn>>;
    try {
      result = store.turns.transition
        ? await transitionTurn(store.turns, renewal)
        : await store.transaction((tx) => transitionTurn(tx.turns, renewal));
    } catch {
      schedule();
      return;
    }
    if (stopped) {
      return;
    }
    if (result.ok) {
      current = next;
      schedule();
      return;
    }
    if (result.reason === "checkpoint-conflict") {
      schedule();
      return;
    }
    stopped = true;
    controller.abort(new TurnOwnershipLostError(runId, result.reason));
  };
  const stopRenewal = (): void => {
    stopped = true;
    clearTimeout(timer);
  };
  schedule();
  return {
    lost: controller.signal,
    release: () => {
      stopRenewal();
      releaseLease();
    },
    stopRenewal,
  };
}

/** Aborts the turn with the loss once `lost` aborts. */
export function forwardTurnOwnershipLoss(
  lost: AbortSignal | undefined,
  turn: AbortController
): void {
  lost?.addEventListener("abort", () => turn.abort(lost.reason), {
    once: true,
  });
}

/** Throws the loss when another owner took the turn's run over. */
export function throwIfTurnOwnershipLost(signal: AbortSignal): void {
  if (signal.reason instanceof TurnOwnershipLostError) {
    throw signal.reason;
  }
}

/**
 * The loss of `runId` behind `error`: a lost lease renewal, or a write of
 * the run that another owner's lease or settlement fenced off.
 */
export function turnOwnershipLoss(
  error: unknown,
  signal: AbortSignal,
  runId: string | undefined
): TurnOwnershipLostError | undefined {
  if (signal.reason instanceof TurnOwnershipLostError) {
    return signal.reason;
  }
  if (error instanceof TurnOwnershipLostError) {
    return error;
  }
  if (
    (error instanceof TurnTransitionConflictError ||
      error instanceof ThreadExecutionCheckpointAuthorityError) &&
    error.runId === runId &&
    error.reason !== "checkpoint-conflict"
  ) {
    return new TurnOwnershipLostError(error.runId, error.reason);
  }
  return;
}

/**
 * Ends a turn whose run another owner took over. That owner continues the
 * run, so this process writes nothing: it reloads committed state and
 * reports the takeover.
 */
export async function abandonLostTurn({
  item,
  loss,
  meterCheckpoint,
  model,
  state,
}: {
  readonly item: ProcessQueuedInputOptions["item"];
  readonly loss: TurnOwnershipLostError;
  readonly meterCheckpoint: Parameters<typeof restoreContextTokenMeter>[1];
  readonly model: ProcessQueuedInputOptions["model"];
  readonly state: ThreadState;
}): Promise<void> {
  restoreContextTokenMeter(model.contextTokenMeter, meterCheckpoint, item.run);
  closeRuntimeInput(item.runtimeInput, "turn-error");
  try {
    await state.refresh();
  } catch (error) {
    state.setContinuationCheckpoint(state.modelSnapshot(), () => {
      throw new Error(
        "Task requires recovery because another process took over its turn. Reload the session before continuing.",
        { cause: error }
      );
    });
  }
  item.run.emit({
    error: { category: "unknown", code: loss.code, version: 1 },
    message: "Another process took over this turn.",
    type: "turn-error",
  });
}
