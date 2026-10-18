---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Durable Execution Recovery, Public API vNext, and Pi v1.3.0 Baseline

Add cross-process turn recovery (`agent.resume` and `thread.continue` over persisted `HostStore` runs and checkpoints), crash-loop `maxAttempts` parking, transactional `HostStoreTransaction.scheduler` outbox support, and the additive RFC 0004 public surface (`AgentTurn` async iteration, `thread.replay()`, `thread.identity`, `DisposedResourceError`, and `AsyncDisposable`). Wire `threadDirectory` and `sessionKey` into `createCodingAgent` and `runCodingAgentExec`, deduplicate the TUI `FileHost` instance, and record the Pi v1.3.0 (`@earendil-works/pi-durable`) compatibility baseline.
