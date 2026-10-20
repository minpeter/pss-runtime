---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Parked turns keep their history

A turn that parks as `needs-recovery` while its process keeps running (a `beforeToolExecution` hook returned `needs-recovery`, or the process lost track of a tool's outcome) no longer rolls the thread back to before the turn. It keeps the user's input and every tool round already committed, so `agent.resolveRecovery()` followed by `agent.resume()` finishes the turn instead of cancelling it or parking it again. A run a hook parked can also be resumed by the same process, without a restart.
