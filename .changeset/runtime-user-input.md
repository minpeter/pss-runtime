---
"@minpeter/pss-runtime": patch
---

Unify user-originated thread events as `user-input` and simplify public thread
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
