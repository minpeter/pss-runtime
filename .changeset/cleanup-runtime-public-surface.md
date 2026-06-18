---
"@minpeter/pss-runtime": patch
---

Clean up the runtime public surface and tighten host/resume contracts.

- Remove unused exports: `runEventPlugins`, `attachRuntimeInputMeta`,
  `stripEventMeta`, and the internal `withSteeringPlacement` helper.
- Remove `AgentPlugin.events.on` (deprecated observe-only shim). Use the
  top-level `on` handler; intercept returns (`continue` / `transform` /
  `handled`) now apply to all plugins uniformly.
- Drop `AgentSession.currentTurnId()`, `enqueueRuntimeInput()`, and the
  private `#enqueuePendingRuntimeInput()` helper; they had no callers.
- Collapse `AgentLanguageModelOptions`, `AgentConstructionOptions`, and
  `AgentOptions` into a single `AgentOptions` interface.
- `Agent.resume(runId)` no longer throws when the host cannot resume; it
  returns `null`. Add `Agent.supportsResume` to check durable-resume support
  before calling. Document that a `host: { sessionStore }` (SessionHost-only)
  object disables the in-memory `ExecutionHost`, so run records, tool
  checkpoints, and `resume()` are unavailable.
- Add a `@minpeter/pss-runtime/namespace` subpath with stable namespace helpers
  (`parentSessionNamespace`, `defaultChildSessionKey`, `agentNamespace`,
  `namespacePart`, `randomAgentNamespace`) so app-owned delegation examples no
  longer copy local namespace formatting helpers.
- Remove no-op internal plumbing: the always-true observer-event filter in the
  agent loop and the unused `BufferedAgentRun.close()` reason parameter.
