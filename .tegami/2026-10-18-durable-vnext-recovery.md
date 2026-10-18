---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Durable Execution Recovery, Public API vNext, and Pi v1.3.0 Baseline

Add cross-process turn recovery (`agent.resume` and `thread.continue` over persisted `HostStore` runs and checkpoints left non-terminal by a crash), crash-loop `maxAttempts` parking, transactional `HostStoreTransaction.scheduler` outbox support, and the RFC 0004 public surface (`AgentTurn` async iteration, `thread.replay()`, `thread.identity`, `DisposedResourceError`, and `AsyncDisposable`). Custom `AgentInstrumentation.wrapTurn` implementations may keep returning `{ events, runId }` (`AgentInstrumentationTurn`); the runtime still returns an iterable `AgentTurn`. After a successful `agent.dispose()`, `thread()`, `send()`, `followUp()`, `overlay()`, and `resume()` throw `DisposedResourceError`. Wire `threadDirectory` and `sessionKey` into `createCodingAgent` and `runCodingAgentExec`, deduplicate the TUI `FileHost` instance, and record the Pi v1.3.0 (`@earendil-works/pi-durable`) compatibility baseline.

`tx.scheduler` is defined only when the host scheduler can join store transactions (memory, file, the default Durable Object storage host, and Celld); `createCloudflareHost` leaves it undefined, so schedule through `host.scheduler` after commit. Celld storage transactions must now provide `getAlarm()`, `setAlarm()`, and `deleteAlarm()`. Scheduled-work drainers acknowledge runs parked as `needs-recovery` instead of retrying them, and a crashed run whose earlier completed tool results cannot be restored is parked as `needs-recovery` rather than resumed.
