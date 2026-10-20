import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import type { AgentTurn } from "../../thread/protocol/turn";
import { abandonedLeaseId, TURN_LEASE_MS } from "../host/lease-owner";
import { isClaimableTurnStatus } from "../host/turn-status";
import type { LeaseOwnerLiveness, TurnRecord, TurnStore } from "../host/types";

/** How long after a lease deadline a backstop checks the run. */
export const TURN_BACKSTOP_MARGIN_MS = 10_000;

/** When a started run's first backstop comes due. */
export const TURN_BACKSTOP_DELAY_MS = TURN_LEASE_MS + TURN_BACKSTOP_MARGIN_MS;

/** The agent a backstop resumes runs through; `Agent` satisfies it. */
export interface TurnBackstopAgent {
  readonly host: {
    readonly ownerLiveness?: LeaseOwnerLiveness;
    readonly store: { readonly turns: Pick<TurnStore, "get"> };
  };
  resume(runId: string): Promise<AgentTurn | null>;
}

/**
 * What a drainer does with a due backstop: `done` acknowledges it; `retry`
 * schedules it again after `runAfterMs`; `resumed` hands over the resumed
 * turn, whose start already scheduled the run's next backstop.
 */
export type TurnBackstopResult =
  | { readonly action: "done" }
  | { readonly action: "resumed"; readonly turn: AgentTurn }
  | { readonly action: "retry"; readonly runAfterMs: number };

/**
 * Checks a run whose backstop came due. A run that settled or parked for a
 * decision is done. A live owner keeps its run until the lease lapses; any
 * other unsettled run, including one requeued after a failed resume, is
 * resumed. A thread busy with other work is retried shortly, and a run this
 * agent cannot resume is checked again after a full backstop delay.
 */
export async function runTurnBackstop(
  agent: TurnBackstopAgent,
  runId: string,
  { nowMs = Date.now() }: { readonly nowMs?: number } = {}
): Promise<TurnBackstopResult> {
  const run = await agent.host.store.turns.get(runId);
  if (!(run && isClaimableTurnStatus(run.status))) {
    return { action: "done" };
  }
  const held = liveOwnerRetry(run, agent, nowMs);
  if (held) {
    return held;
  }
  let turn: AgentTurn | null;
  try {
    turn = await agent.resume(runId);
  } catch (error) {
    if (error instanceof ToolExecutionNeedsRecoveryError) {
      return { action: "done" };
    }
    if (isBusy(error)) {
      return { action: "retry", runAfterMs: TURN_BACKSTOP_MARGIN_MS };
    }
    throw error;
  }
  if (turn) {
    return { action: "resumed", turn };
  }
  const after = await agent.host.store.turns.get(runId);
  if (!(after && isClaimableTurnStatus(after.status))) {
    return { action: "done" };
  }
  return (
    liveOwnerRetry(after, agent, nowMs) ?? {
      action: "retry",
      runAfterMs: TURN_BACKSTOP_DELAY_MS,
    }
  );
}

/** A retry just past `run`'s lease while a live owner holds it. */
function liveOwnerRetry(
  run: TurnRecord,
  agent: TurnBackstopAgent,
  nowMs: number
): TurnBackstopResult | undefined {
  const lease = run.lease;
  if (
    lease &&
    lease.leaseUntilMs > nowMs &&
    abandonedLeaseId(run, agent.host.ownerLiveness) === undefined
  ) {
    return {
      action: "retry",
      runAfterMs: lease.leaseUntilMs - nowMs + TURN_BACKSTOP_MARGIN_MS,
    };
  }
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "THREAD_CONTINUATION_BUSY"
  );
}
