---
"@minpeter/pss-runtime": patch
---

Harden Cloudflare Durable Object storage for production agent threads.

- Make `RunStore.create()` insert-only and return typed duplicate results so
  notification idempotency races do not overwrite canonical runs.
- Stop retrying scheduled non-notification runs forever when the runtime cannot
  resume them.
- Store lower-level resume checkpoints as bounded thread references instead of
  full history snapshots.
- Normalize scheduled work rows with `thread_key` and `run_id` indexes for
  exact cleanup.
- Add append-delta writes and chunked oversized thread-message payloads for the
  SQLite thread store.
