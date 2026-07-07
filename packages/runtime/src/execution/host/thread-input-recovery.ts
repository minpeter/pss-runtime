import type {
  RecoverThreadInputClaimsResult,
  ThreadInputRecord,
} from "./types";

export interface ThreadInputRecoveryTransition
  extends RecoverThreadInputClaimsResult {
  readonly records: readonly ThreadInputRecord[];
}

export function recoverThreadInputClaims(
  records: readonly ThreadInputRecord[],
  threadKey: string
): ThreadInputRecoveryTransition {
  const released: ThreadInputRecord[] = [];
  const acked: ThreadInputRecord[] = [];
  const recovered = records.map((record) => {
    if (record.threadKey !== threadKey) {
      return record;
    }

    if (record.status === "claiming") {
      const next = recordWithoutClaimId(record, "pending");
      released.push(next);
      return next;
    }

    if (record.status === "promoted") {
      const next = recordWithoutClaimId(record, "acked");
      acked.push(next);
      return next;
    }

    return record;
  });

  return { acked, records: recovered, released };
}

export function recordWithoutClaimId(
  record: ThreadInputRecord,
  status: "acked" | "pending"
): ThreadInputRecord {
  const { claimId: _claimId, ...rest } = record;
  return { ...rest, status };
}
