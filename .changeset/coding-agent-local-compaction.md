---
"@minpeter/pss-coding-agent": patch
---

Add local thread compaction configuration and inspection support to the coding
agent CLI.

The TUI now shows the active thread key and auto-compaction policy, accepts
`PSS_THREAD_*` storage settings with legacy `PSS_SESSION_*` aliases, and can
enable runtime auto-compaction through `PSS_AUTO_COMPACTION_MIN_MESSAGES` plus
`PSS_AUTO_COMPACTION_RETAIN_MESSAGES`. The CLI also adds `pss inspect-thread`
for checking the configured local thread file without starting the TUI.
