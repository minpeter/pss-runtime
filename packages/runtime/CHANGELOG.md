# @minpeter/pss-runtime

## 0.1.0-next.22

### Patch Changes

- Rename visible assistant response events from `assistant-text` to `assistant-output`.
  The new name better matches the thread model where user messages are inputs and
  assistant messages are model outputs appended back into the thread.

## 0.1.0-next.21

### Patch Changes

- Unify user-originated thread events as `user-input` and simplify public thread
  input to plain text, text arrays, or content-part arrays. Object-shaped
  `user-text` and `user-message` inputs are no longer part of the public
  `send()`/`steer()` surface; notification/resume internals still persist a typed
  `user-input` payload.

  Add noncanonical `thread.overlay(input)` for next-turn runtime context.
  Overlays accept the same input shapes as `send()`, are chainable, and enter the
  next turn as `runtime-input` before the user message rather than as another
  human `user-input` event. Overlay context is visible to the current model turn
  but is excluded from stored thread history and automatic compaction summaries.

  Add notification resume overlays so durable notification turns can inject fresh
  per-run context without baking that context into the canonical thread log.

## 0.1.0-next.20

### Patch Changes

- 41736e7: Add opt-in automatic Thread compaction for long-running agents.

  - Add `AgentOptions.autoCompaction` with validated `minMessages` and
    `retainMessages` thresholds.
  - Persist compaction summaries as `pss_thread_compaction` rows while keeping the
    full durable Thread log intact.
  - Schedule compaction after successful user-input turns without blocking turn
    completion.

## 0.1.0-next.19

### Patch Changes

- 515b089: Fix the runtime README to document the exported `thread-store/file` subpath without referencing the removed `session-store/file` path.

## 0.1.0-next.18

### Patch Changes

- 320c01c: Add a Node platform adapter with file-backed thread and execution hosts, including resumable run storage, notification inbox persistence, checkpoints, events, and local scheduled-work files. Also move Cloudflare internals under `src/platform/cloudflare` while keeping the public Cloudflare subpath stable.
- 8c3e696: Replace legacy session/run public aliases with Thread, Turn, and Checkpoint runtime naming.

## 0.1.0-next.17

### Patch Changes

- c8bf377: Support scheduled work payload LIKE deletes in the local Durable Object SQL test adapter.

## 0.1.0-next.16

### Patch Changes

- a5418f0: Support secondary-index scheduled work deletes in the local Durable Object SQL test adapter.

## 0.1.0-next.15

### Patch Changes

- d1e0186: Add a local Cloudflare Durable Object storage stress harness, including an opt-in 200MB-scale extreme profile, and expose host-level payload budget configuration.

## 0.1.0-next.14

### Patch Changes

- f3c4461: Harden Cloudflare Durable Object storage for production agent threads.

  - Make `RunStore.create()` insert-only and return typed duplicate results so
    notification idempotency races do not overwrite canonical runs.
  - Stop retrying scheduled non-notification runs forever when the runtime cannot
    resume them.
  - Store lower-level resume checkpoints as bounded thread references instead of
    full history snapshots.
  - Normalize scheduled work rows with `thread_key` and `run_id` indexes for
    exact cleanup.
  - Add append-delta writes and chunked oversized thread-message payloads for the
    SQLite thread store.

## 0.1.0-next.13

### Patch Changes

- ae58a13: Store Cloudflare Durable Object notification records in SQLite rows with legacy KV read-through, and make runtime checkpoint ids include run, version, and phase metadata.

## 0.1.0-next.12

### Patch Changes

- a58c756: Rename Cloudflare SQLite thread history tables from `pss_session_*` to `pss_thread_*` with legacy row migration, and store run records in SQLite rows instead of Durable Object KV values.

## 0.1.0-next.11

### Patch Changes

- Harden Cloudflare Durable Object storage for long-running agent threads and
  rename the runtime domain from sessions to threads. Runtime storage now rejects
  oversized single-row payloads before Durable Object writes, stores tool
  checkpoints as bounded thread references instead of full history snapshots, and
  uses a SQLite row queue for scheduled Cloudflare work.

  The public app-facing API now uses `agent.thread(...)`, `ThreadInput`, and
  ThreadStore names. Deprecated Session aliases remain as explicit compatibility
  adapters, while the coding-agent local thread store imports have moved to the
  new thread-store subpaths.

## 0.1.0-next.10

### Patch Changes

- 641ccbf: Rename execution, Cloudflare scheduling, and notification APIs from
  `sessionKey`/`resumeSession`/scheduled session prompts to
  `threadKey`/`resumeThread`/scheduled thread prompts. Thread keys are now the
  public app-facing address for linear conversation history, while existing
  storage-session internals remain opaque behind the runtime host boundary.

## 0.1.0-next.9

### Patch Changes

- 4a2ab2b: Expose a Cloudflare notification idempotency helper so Durable Object alarm handlers can recover product-level source keys from runtime-scoped scheduled prompts.
- 1dd09de: Replace the public `agent.session(key)` entrypoint with `agent.thread(key)`.
  Threads are the app-facing conversation unit; runtime session state remains an
  internal storage concern behind the thread handle. `agent.thread({ key, scope })`
  now provides an optional scoped address for multi-user integrations while
  preserving opaque session storage under the host boundary.

## 0.1.0-next.8

### Patch Changes

- 5cc6285: Clean up the runtime public surface and tighten host/resume contracts.

  - Remove unused internal helpers: `runEventPlugins`, `attachRuntimeInputMeta`,
    `stripEventMeta`, and `withSteeringPlacement`. Keep the package-root
    `runPluginsForEvent` helper for compatibility with plugin test utilities.
  - Remove `AgentPlugin.events.on` (deprecated observe-only shim). Use the
    top-level `on` handler; intercept returns (`continue` / `transform` /
    `handled`) now apply to all plugins uniformly.
  - Drop `AgentSession.currentTurnId()`, `enqueueRuntimeInput()`,
    `emitObserverEvent()`, and the private `#enqueuePendingRuntimeInput()` helper;
    they were unused or test-only public-ish hooks. Observer-event behavior is now
    covered through `SessionEventDispatcher` tests.
  - Collapse `AgentLanguageModelOptions`, `AgentConstructionOptions`, and
    `AgentOptions` into a single `AgentOptions` interface.
  - Remove the empty `AgentHostCapabilities` type and replace duck-typed host
    detection with a discriminated host union (`kind: "session" | "execution" |
"durable-background"`). Session-only hosts now pass
    `host: { kind: "session", sessionStore }`.
  - `Agent.resume(runId)` no longer throws when the host cannot resume; it
    returns `null`. Add `Agent.supportsResume` to check durable-resume support
    before calling. Document that a `SessionHost` disables the in-memory
    `ExecutionHost`, so run records, tool checkpoints, and `resume()` are
    unavailable.
  - Add a `@minpeter/pss-runtime/namespace` subpath with stable namespace helpers
    (`parentSessionNamespace`, `defaultChildSessionKey`, `agentNamespace`,
    `namespacePart`, `randomAgentNamespace`) so app-owned delegation examples no
    longer copy local namespace formatting helpers.
  - Remove Cloudflare Durable Object non-SQLite store fallbacks and legacy session
    migration; `createCloudflareDurableObjectHost` now requires `storage.sql` and
    wires SQLite event/checkpoint/session stores directly. The exported
    `InMemoryCloudflareDurableObjectStorage` remains constructible without
    arguments for test suites and supplies an in-memory SQLite-compatible backing
    store by default.
  - Remove no-op internal plumbing: the always-true observer-event filter in the
    agent loop and the unused `BufferedAgentRun.close()` reason parameter.

- d1c015c: Add Cloudflare notification dispatch helpers and context-aware alarm draining for multi-user Durable Object runtimes.
- 74dc8de: Fix Cloudflare notification dispatch dedupe scope, active notification observer
  events, and stale or budgeted alarm retry handling.

## 0.1.0-next.7

### Patch Changes

- 0a1f556: Add `DurableObjectSqliteEventStore` and `DurableObjectSqliteCheckpointStore`,
  the append-only SQLite counterparts to the legacy KV event/checkpoint stores.

  Like `DurableObjectSqliteSessionStore`, they persist one small SQLite row per
  event / per checkpoint instead of re-writing the whole per-run list into a
  single `storage.put` value on every append. A run with many large tool-result
  events or full-history checkpoints can no longer cross the Durable Object ~2MB
  per-value limit (`SQLITE_TOOBIG`) by accumulation — the failure that surfaced as
  `Error: string or blob too big: SQLITE_TOOBIG` on the `afterTool` checkpoint
  write after tools such as `web_search`.

  `createCloudflareDurableObjectHost` now selects these SQLite stores
  automatically when `storage.sql` is available (ChatRoom-style SQLite-backed
  Durable Objects), and keeps the legacy KV stores on non-SQLite storage, so no
  caller change is required. Event cursors (1-based skip offsets), checkpoint
  `stale-version` optimistic checks, and `latest()` semantics are preserved
  byte-for-byte. Both new stores are re-exported from
  `@minpeter/pss-runtime/cloudflare`.

## 0.1.0-next.6

### Patch Changes

- Sync dependency updates from main into the v0.1 prerelease line.

## 0.1.0-next.5

### Patch Changes

- b687931: Add `DurableObjectSqliteSessionStore`, an append-only session store for
  SQLite-backed Durable Objects. It persists conversation history as one small
  SQLite row per message (delta-append on commit, reconstruct on load) instead of
  re-serializing the entire snapshot into a single `storage.put` value every turn,
  so long sessions no longer cross the Durable Object ~2MB per-value limit
  (`SQLITE_TOOBIG`). Rollbacks soft-delete the trailing rows, the optimistic
  version/conflict semantics are preserved byte-for-byte, and any pre-existing
  `storage.put` snapshot is lazily migrated into rows on first access. Opt in via
  the existing `sessionStore` option of `createCloudflareDurableObjectHost`; the
  default store is unchanged.

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
