---
"@minpeter/pss-runtime": patch
---

Add plugin-first session persistence, memory, and event-first runtime control.

- Keep `run.events()` as the app-owned runtime control loop for synchronized rendering, tracing, and continuation policy.
- Add constructor-level `plugins: [...]` support with a single `on(context)` handler per plugin.
- `on` is observe-only for most events. Three input event types (`user-text`, `user-message`, `runtime-input`) support intercept returns: `{ action: "continue" }`, `{ action: "transform", event }`, or `{ action: "handled" }`.
- Plugins run in registration order; transforms chain so each plugin sees the previous plugin's event.
- Route plugin logic on `event.meta?.source` (`send`, `steer`, `notify`, `delegate`). Meta is stripped before session history persistence and model mapping, so it never reaches the LLM prompt.
- Use `host: { kind: "session", sessionStore }` for session-only persistence, `run.events()` plus `session.steer()` for app control, or constructor `plugins: [...]` for reusable middleware.
