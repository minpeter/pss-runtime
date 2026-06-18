---
"@minpeter/pss-runtime": patch
---

Normalize AI SDK fallback tool-call ids such as `delegate_to_researcher_0` to
stable `call_*` ids so tool results, tool execution checkpoints, and session
mapping stay consistent across model snapshots.
