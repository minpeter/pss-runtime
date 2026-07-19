---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Inspect durable turn lifecycle by run ID

Expose a stable optional `AgentTurn.runId` for durable work accepted by an
execution host. Precreate queued user-turn runs after durable input admission,
carry the same run through execution and checkpoints, and bind resumed
notifications to the run ID returned by `dispatchAgentNotification`.

Add read-only `inspectDurableTurn(source, runId)` to the existing `./execution`
subpath. Recorded runs report status, thread key, checkpoint version, and the
latest checkpoint, with explicit unsupported, unknown-run, and no-checkpoint
states.

Make thread shutdown await durable cancellation of queued, active, and
admission-racing runs while preserving completed, failed, recovery, and already
cancelled terminal statuses.
