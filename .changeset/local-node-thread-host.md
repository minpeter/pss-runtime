---
"@minpeter/pss-runtime": patch
---

Add a Node platform adapter with file-backed thread and execution hosts, including resumable run storage, notification inbox persistence, checkpoints, events, and local scheduled-work files. Also move Cloudflare internals under `src/platform/cloudflare` and publish platform adapters under `@minpeter/pss-runtime/platform/*`.
