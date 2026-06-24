---
"@minpeter/pss-runtime": patch
---

Add read-only thread inspection to the core runtime: `Agent.inspectThread(thread)`
and `ThreadHandle.inspect()` return a `ThreadInspection` snapshot (existence,
stored version, message count, and compaction summary sizes) without committing
or mutating thread state. Exports the `ThreadInspection` and
`ThreadInspectionCompaction` types from the package root.
