---
"@minpeter/pss-runtime": patch
---

Clean up the runtime public surface and tighten host/resume contracts.

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
- Move platform adapters to domain-first public subpaths:
  `@minpeter/pss-runtime/platform/cloudflare`,
  `@minpeter/pss-runtime/platform/file`, and
  `@minpeter/pss-runtime/platform/memory`.
- Remove the legacy `@minpeter/pss-runtime/thread-store/file` subpath; import
  `FileThreadStore` from `@minpeter/pss-runtime/platform/file`.
- Remove Cloudflare Durable Object non-SQLite store fallbacks and legacy session
  migration; `createCloudflareDurableObjectHost` now requires `storage.sql` and
  wires SQLite event/checkpoint/session stores directly. The exported
  `InMemoryCloudflareDurableObjectStorage` remains constructible without
  arguments for test suites and supplies an in-memory SQLite-compatible backing
  store by default.
- Remove no-op internal plumbing: the always-true observer-event filter in the
  agent loop and the unused `BufferedAgentRun.close()` reason parameter.
