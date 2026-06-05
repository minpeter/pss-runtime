---
"@minpeter/pss-runtime": patch
---

Add plugin-first session persistence, memory, and compaction APIs, plus event-first runtime control.

- Add `consumeRunEvents(run, listeners)` for ordered multi-listener event consumption while preserving run boundary backpressure.
- Expand plugin lifecycle middleware with `beforeTurn`, `beforeStep`, `afterStep`, and `afterTurn` handlers that can call scoped `steer(...)`.
- Remove legacy top-level `Agent.create({ sessions: { store } })` and `Agent.create({ hooks })` options. Use `plugins: [sessions.custom(store)]` for persistence, `run.events()` plus `session.steer()` for app control, or plugin lifecycle handlers for reusable middleware.
