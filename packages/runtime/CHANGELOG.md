# @minpeter/pss-runtime

## 0.1.0

### Minor Changes

- 37a14b9: Add serializable image/file content parts to `agent.send` and session sends, preserving them through runtime-owned session snapshots.

### Patch Changes

- 37a14b9: Document first-pass image input support in the runtime session/send API.
- 1b43c77: Keep runtime transcripts event-only while storing session continuation state as an internal versioned snapshot.

## 0.0.5

### Patch Changes

- fbe0448: Make agent sessions runtime-owned and durable through an opaque session store boundary, including memory/file stores and coding-agent TUI file-backed sessions.

## 0.0.4

### Patch Changes

- 23cce55: Accept AI SDK ToolSet directly for runtime Agent tools.

## 0.0.3

### Patch Changes

- c5b7c8b: Allow `AgentSession.submit()` user text to be passed as an array of strings for host-rendered per-turn context.

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
