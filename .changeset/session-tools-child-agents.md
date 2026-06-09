---
"@minpeter/pss-runtime": patch
---

Add `resumeBackgroundChildRun` so apps can resume durable background child runs by passing a child `Agent` at the call site, without runtime `subagents` or child-agent registries.