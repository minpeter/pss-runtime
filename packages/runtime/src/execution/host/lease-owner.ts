import type { LeaseOwnerLiveness, TurnLeaseOwner, TurnRecord } from "./types";

/** How long a turn lease lasts before another process may replace it. */
export const TURN_LEASE_MS = 300_000;

/** How often a running turn renews its lease. */
export const TURN_LEASE_RENEW_MS = TURN_LEASE_MS / 3;

interface ProcessLeases {
  /** Leases of runs this process is running right now. */
  readonly active: Set<string>;
  readonly ownerId: string;
}

// Shared through globalThis so runtime copies bundled into one process agree.
const PROCESS_LEASES = Symbol.for("@minpeter/pss-runtime/process-leases");

function processLeases(): ProcessLeases {
  const scope = globalThis as { [PROCESS_LEASES]?: ProcessLeases };
  scope[PROCESS_LEASES] ??= {
    active: new Set(),
    ownerId: crypto.randomUUID(),
  };
  return scope[PROCESS_LEASES];
}

/** The owner this process records on the leases it takes. */
export function processLeaseOwner(
  liveness: LeaseOwnerLiveness | undefined
): TurnLeaseOwner {
  return { ...liveness?.self, id: processLeases().ownerId };
}

/**
 * Marks a lease as held by a turn running in this process until the
 * returned release runs.
 */
export function holdRunningLease(leaseId: string): () => void {
  const { active } = processLeases();
  active.add(leaseId);
  return () => {
    active.delete(leaseId);
  };
}

/**
 * The id of `run`'s lease when its owner is provably gone, so a claim may
 * replace the lease before it expires: another process that `liveness`
 * proves gone, or this process when no turn here runs the run any more. Any
 * other lease, and a lease without an owner, frees only on expiry.
 */
export function abandonedLeaseId(
  run: TurnRecord,
  liveness: LeaseOwnerLiveness | undefined
): string | undefined {
  const lease = run.lease;
  if (!lease?.owner) {
    return;
  }
  const leases = processLeases();
  if (lease.owner.id === leases.ownerId) {
    // A claimed run that has not started yet is not abandoned.
    return run.status === "running" && !leases.active.has(lease.leaseId)
      ? lease.leaseId
      : undefined;
  }
  return liveness?.isGone(lease.owner) ? lease.leaseId : undefined;
}
