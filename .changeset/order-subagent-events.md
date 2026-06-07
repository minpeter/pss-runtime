---
"@minpeter/pss-runtime": patch
---

Order subagent lifecycle events after the parent delegate tool call and before the matching tool result. Normalize AI SDK fallback tool-call ids such as `delegate_to_researcher_0` to `call_*`, and include `delegateToolCallId` on subagent lifecycle events so callers can correlate `delegate_to_*` calls with `bg_*` background jobs.
