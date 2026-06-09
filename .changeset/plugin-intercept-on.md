---
"@minpeter/pss-runtime": patch
---

Add unified `plugins[].on` intercept returns for `user-text`, `user-message`, and `runtime-input` (`continue`, `transform`, `handled`). Input events now carry optional `meta.source` (`send`, `steer`, `notify`, `delegate`) on `run.events()`; meta is stripped before history and model mapping.

**Breaking:** Remove `wrapDelegatePrompt` from `AgentOptions` and subagent registration. Migrate to child-agent plugins that transform input when `meta.source === "delegate"`. Export `delegateUserInput`, `attachInputMeta`, `stripInputMeta`, and related intercept types.

**Deprecated:** `plugins[].events.on` remains observe-only; use top-level `plugins[].on` for intercept.