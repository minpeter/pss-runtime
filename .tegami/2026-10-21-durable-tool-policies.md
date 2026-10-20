---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Crash recovery follows each tool's retry policy

A tool call that a crash left unfinished is now settled before the recovered turn's first model request: `pure` and `idempotent` calls run again under the same idempotency key, the new `interrupt` policy reports the call to the model as interrupted, and `manual-recovery` calls park the run until `agent.resolveRecovery(runId, …)` records a decision (`rerun`, `interrupt`, or a supplied `result`). Cancelling the recovered turn keeps the outcomes already settled and reports the rest as interrupted. Pure calls no longer write an intent checkpoint of their own. The coding agent now declares policies for its built-in tools: reads and web tools run again; edits, writes, deletes, and shell commands are reported as interrupted. `runCodingAgentExec` refuses new work while the session's run has recorded recovery decisions.
