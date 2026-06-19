---
"@minpeter/pss-runtime": patch
---

Rename Cloudflare SQLite thread history tables from `pss_session_*` to `pss_thread_*` with legacy row migration, and store run records in SQLite rows instead of Durable Object KV values.
