# @minpeter/pss-runtime

## 0.1.0-next.4

### Patch Changes

- 1f3a46c: Remove the public runtime LLM function adapter surface. Agent model execution now accepts AI SDK LanguageModel objects directly, and runtime tests use AI SDK MockLanguageModelV4 fixtures.

## 0.1.0-next.3

### Patch Changes

- fc024ec: Remove the unreleased runtime-owned subagent API and implementation. Delegation now stays app-owned through ordinary tools, sessions, and host-owned background runs; see the sync and background examples for those patterns.
- b21c318: Split durable/background host capabilities into smaller execution subpath contracts and publish a Cloudflare Durable Object adapter from `@minpeter/pss-runtime/cloudflare`.

## 0.1.0-next.2

### Patch Changes

- e989f88: Add the `host` execution contract for resumable runs and durable
  notification resume. Advanced execution host, store, and scheduler contracts
  are available from `@minpeter/pss-runtime/execution`, and runtime-originated
  work can resume through `Agent.resume(runId)`.

  Durable background scheduling is host-owned: apps can persist their own run
  records and completion notifications while the runtime keeps the generic
  execution store, scheduler, and notification resume primitives.

- b03d3ac: Normalize AI SDK fallback tool-call ids such as `lookup_0` to
  `call_*` so app-owned tools can correlate model tool calls with their own
  durable work records.
- b03d3ac: Implement constructor-level `plugins: [...]` event observers and lifecycle middleware.

## 0.1.0-next.1

### Patch Changes

- ae8de0e: Replace the async Agent factory with direct construction and keep
  delegation as app-owned tool composition.

## 0.1.0-next.0

### Minor Changes

- 0ffe9e7: Add plugin-first session persistence, memory, and compaction APIs, plus event-first runtime control.

  - Keep `run.events()` as the app-owned runtime control loop for synchronized rendering, tracing, and continuation policy.
  - Expand plugin lifecycle middleware with `turn.before`, `step.before`, `step.after`, and `turn.after` handlers that can call scoped `steer(...)`.
  - Route plugin lifecycle handler failures through the returned run so callers own observability.
  - Add runtime-owned tool policy middleware with `tool.call` and `tool.result` for allow, modify, reject-and-continue, synthesize, error, and result replacement flows.
  - Use `host: { sessionStore }` for persistence, `run.events()` plus `session.steer()` for app control, or plugin lifecycle handlers for reusable middleware.

### Patch Changes

- 3761c93: Add turn-scoped session overlays with non-persistent `session.overlay(input)` runtime context, overlay lifecycle events, and plugin lifecycle overlay helpers.

## 0.0.10

### Patch Changes

- 5fc427d: Hide the internal agent loop runner from the root runtime export and clarify the session store version contract so stores own loaded-session versions while commit payloads carry state only.

  Rename the synchronized run event iterator from `run.stream()` to `run.events()` across the runtime API and examples. This intentionally removes `run.stream()`; replace calls with `run.events()`.

## 0.0.9

### Patch Changes

- 20103d2: Make the coding-agent TUI subpath import-safe, correct multimodal docs, and trim redundant runtime type exports.

## 0.0.8

### Patch Changes

- c991a6a: Replace the public current-turn input API with `session.steer(input)` and keep
  `session.send(input)` as the new-turn queue. Active TUI submissions now steer the
  current run through the session API.

## 0.0.7

### Patch Changes

- c71ea7d: Add runtime `toolChoice` configuration and lifecycle events for turns and steps.

## 0.0.6

### Patch Changes

- 37a14b9: Add serializable image/file content parts to `agent.send` and session sends, preserving them through runtime-owned session snapshots.
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

  - Add `history` hydration through `AgentSession` constructor options.
  - Introduce `getHistory()` to retrieve the current snapshot of the agent's message history.
  - Add lifecycle callbacks to `AgentSession` and model history for serialized mutation-time history snapshots.
  - Keep `kill()` from hanging active turns that are waiting on stalled history persistence.
  - Export `AgentMessage` globally from `@minpeter/pss-runtime` for clean external representation of internal AI SDK message structures.

## 0.0.1

### Patch Changes

- 8f03383: Publish the initial pss-next runtime and coding-agent packages from the new Turborepo workspace.
