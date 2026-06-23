---
"@minpeter/pss-runtime": patch
---

Add `streamAssistantText(turn)` and `collectAssistantText(turn)` root exports as
thin, ergonomic wrappers over `turn.events()` for the common visible-text-only
consumption case. They preserve the canonical single-consumer event contract:
each helper consumes `turn.events()` exactly once and drops every non-visible
event. Use `turn.events()` directly when you need tool, lifecycle, or telemetry
events.
