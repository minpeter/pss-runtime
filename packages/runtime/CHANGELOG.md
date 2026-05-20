# @minpeter/pss-runtime

## 0.0.2

### Patch Changes

- f503ccd: Enhance `AgentSession` with state hydration, mutation tracking, and broader TypeScript type exports:

  - Add `history` hydration via `SessionOptions` in `Agent.createSession()` and `AgentSession` constructor.
  - Introduce `getHistory()` to retrieve the current snapshot of the agent's message history.
  - Add `onHistoryChange` lifecycle callback hook to `AgentSession` (and underlying `AgentModelHistory`) to observe and persist serialized mutation-time history snapshots.
  - Keep `kill()` from hanging active turns that are waiting on stalled history persistence.
  - Export `AgentMessage` globally from `@minpeter/pss-runtime` for clean external representation of internal AI SDK message structures.

## 0.0.1

### Patch Changes

- 8f03383: Publish the initial pss-next runtime and coding-agent packages from the new Turborepo workspace.
