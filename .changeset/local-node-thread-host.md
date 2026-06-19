---
"@minpeter/pss-runtime": patch
---

Add a Node platform adapter with file-backed thread and execution hosts, including resumable run storage, notification inbox persistence, checkpoints, events, and local scheduled-work files. Also move Cloudflare internals under `src/platform/cloudflare` while keeping the public Cloudflare subpath stable.
