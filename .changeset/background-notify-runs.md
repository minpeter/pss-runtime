---
"@minpeter/pss-runtime": patch
---

Add the `host` execution contract for resumable runs, durable notification resume,
and background subagent capability detection. Advanced execution host, store,
and scheduler contracts live under `@minpeter/pss-runtime/execution`.
Background delegation now exposes background tools only when the host advertises
support, persists child run links for cleanup/cancellation, and resumes parents
through an idempotent notification claim. Scheduler resume calls now carry the
notification idempotency metadata adapters need to resume the parent without
reconstructing internal keys.

Agent construction now routes session persistence through
`host: { sessionStore }` plus top-level `namespace`. App-facing `SessionHandle`
objects expose `send`, `steer`, `delete`, `interrupt`, and `kill`;
runtime-originated input resumes through `Agent.resume(runId)`. The public
`Agent` constructor uses `model` for both AI SDK models and custom `RuntimeLlm`
functions. High-level managed model turns on an execution host now record
`user-turn` runs and before/after tool checkpoints. `AgentToolChoice` now
preserves the AI SDK tool-choice shape, including named tool selection for
providers that support it.

Durable adapters own actual scheduling/leases/resume workers; the Cloudflare
example shows a Worker/Durable Object shaped host adapter with local `ctx.storage`
simulation, alarm-driven resume, and Wrangler entrypoints. This prerelease branch
uses a patch changeset by default per repository release policy; no semver-major
release level was requested for this work.
