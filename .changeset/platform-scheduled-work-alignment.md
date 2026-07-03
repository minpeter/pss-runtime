---
"@minpeter/pss-runtime": patch
---

Align scheduled-work semantics across platform adapters: shared work-id derivation, thread-prompt validation, and list limits now live in one platform-neutral module consumed by the memory, file, and cloudflare adapters. The in-memory scheduler now honors `runAfterMs`, dedupes runs and thread prompts like the durable adapters, and exposes `listScheduledRuns` / `listScheduledThreadPrompts` / ack APIs. A new ExecutionScheduler contract test suite runs against all three platforms.
