---
"@minpeter/pss-runtime": patch
---

Hide the internal agent loop runner from the root runtime export and clarify the session store version contract so stores own loaded-session versions while commit payloads carry state only.

Rename the synchronized run event iterator from `run.stream()` to `run.events()` across the runtime API and examples. This intentionally removes `run.stream()`; replace calls with `run.events()`.
