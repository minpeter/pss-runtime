---
"@minpeter/pss-runtime": minor
---

Add plugin-first session persistence, memory, and compaction APIs, plus event-first runtime control.

- Keep `run.events()` as the app-owned runtime control loop for synchronized rendering, tracing, and continuation policy.
- Add constructor-level `plugins: [...]` lifecycle middleware support.
- Expand plugin lifecycle middleware with `turn.before`, `step.before`, `step.after`, and `turn.after` handlers that can call scoped `steer(...)`.
- Route plugin lifecycle handler failures through the returned run so callers own observability.
- Add runtime-owned tool policy middleware with `tool.call` and `tool.result` for allow, modify, reject-and-continue, synthesize, error, and result replacement flows.
- Use `host: { sessionStore }` for persistence, `run.events()` plus `session.steer()` for app control, or plugin lifecycle handlers for reusable middleware.
