---
"@minpeter/pss-runtime": patch
---

Add plugin-first session persistence, memory, and compaction APIs, plus event-first runtime control.

- Keep `run.events()` as the app-owned runtime control loop for synchronized rendering, tracing, and continuation policy.
- Expand plugin lifecycle middleware with `turn.before`, `step.before`, `step.after`, and `turn.after` handlers that can call scoped `steer(...)`.
- Add runtime-owned tool policy middleware with `tool.call` and `tool.result` for allow, modify, reject-and-continue, synthesize, error, and result replacement flows.
- Remove legacy top-level `Agent.create({ sessions: { store } })` and `Agent.create({ hooks })` options. Use `plugins: [sessions.custom(store)]` for persistence, `run.events()` plus `session.steer()` for app control, or plugin lifecycle handlers for reusable middleware.
