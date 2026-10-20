import {
  type AgentHost,
  inspectDurableTurn,
  type LeaseOwnerLiveness,
  type TurnLeaseOwner,
  type TurnRecord,
} from "@minpeter/pss-runtime/execution";

/** A session's last turn that neither finished nor failed. */
export type UnfinishedTurn =
  /** Its process is gone; continuing resumes it. */
  | { readonly kind: "interrupted" }
  /** It stopped where only a recovery decision could resume it. */
  | { readonly kind: "needs-decision"; readonly toolName?: string }
  /** A live process still holds it. */
  | { readonly kind: "running-elsewhere"; readonly pid?: number };

/**
 * Reads the thread's last turn and reports it when unfinished. It claims
 * nothing, so a live owner keeps its turn and nothing resumes on its own.
 */
export async function findUnfinishedTurn(
  host: AgentHost,
  threadKey: string,
  nowMs = Date.now()
): Promise<UnfinishedTurn | undefined> {
  const run = (await host.store.turns.listByThreadKey?.(threadKey))
    ?.filter((record) => record.kind !== "notification")
    .at(-1);
  if (
    !run ||
    run.status === "cancelled" ||
    run.status === "completed" ||
    run.status === "error"
  ) {
    return;
  }
  const holder = liveHolder(run, host.ownerLiveness, nowMs);
  if (holder) {
    return {
      kind: "running-elsewhere",
      ...(holder.pid === undefined ? {} : { pid: holder.pid }),
    };
  }
  const inspection = await inspectDurableTurn(host, run.runId);
  const undecided = (
    "pendingToolCalls" in inspection ? inspection.pendingToolCalls : []
  ).find(
    (call) => call.policy === "manual-recovery" && call.resolution === undefined
  );
  if (run.status === "needs-recovery" || undecided) {
    return {
      kind: "needs-decision",
      ...(undecided === undefined ? {} : { toolName: undecided.toolName }),
    };
  }
  return { kind: "interrupted" };
}

/** What to tell the user about `turn`. */
export function unfinishedTurnMessage(turn: UnfinishedTurn): string {
  switch (turn.kind) {
    case "interrupted":
      return "■ interrupted - press Enter to continue, or enter new instructions.";
    case "needs-decision":
      return turn.toolName === undefined
        ? "■ interrupted and cannot resume - enter new instructions to move on."
        : `■ interrupted while ${turn.toolName} may have partly run - check its effects, then enter new instructions.`;
    case "running-elsewhere":
      return turn.pid === undefined
        ? "The last turn is still running in another process."
        : `The last turn is still running in another pss process (pid ${turn.pid}).`;
    default:
      return turn satisfies never;
  }
}

/**
 * The process entitled to the run until its lease lapses: one that is not
 * this process and that the host cannot prove gone.
 */
function liveHolder(
  run: TurnRecord,
  liveness: LeaseOwnerLiveness | undefined,
  nowMs: number
): { readonly pid?: number } | undefined {
  const lease = run.lease;
  if (!lease || lease.leaseUntilMs <= nowMs) {
    return;
  }
  const owner = lease.owner;
  if (owner && (isSelf(owner, liveness?.self) || liveness?.isGone(owner))) {
    return;
  }
  return owner?.pid === undefined ? {} : { pid: owner.pid };
}

function isSelf(
  owner: TurnLeaseOwner,
  self: LeaseOwnerLiveness["self"]
): boolean {
  return (
    self?.pid !== undefined &&
    owner.pid === self.pid &&
    owner.hostname === self.hostname &&
    owner.processStart === self.processStart
  );
}
