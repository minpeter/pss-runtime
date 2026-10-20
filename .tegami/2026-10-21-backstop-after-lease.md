---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## A post-commit backstop waits for the turn's lease

On a host whose scheduler has `scheduleBackstop` but whose store transactions cannot schedule one, a turn now holds its lease before scheduling the run's first check. When that check cannot be scheduled, the run goes back to `queued` without a lease and the turn fails to start, instead of staying `running` with no turn renewing it and no check scheduled.
