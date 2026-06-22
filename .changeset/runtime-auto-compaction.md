---
"@minpeter/pss-runtime": patch
---

Add opt-in automatic Thread compaction for long-running agents.

- Add `AgentOptions.autoCompaction` with validated `minMessages` and
  `retainMessages` thresholds.
- Persist compaction summaries as `pss_thread_compaction` rows while keeping the
  full durable Thread log intact.
- Schedule compaction after successful user-input turns without blocking turn
  completion.
