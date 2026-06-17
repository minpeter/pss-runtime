---
"@minpeter/pss-runtime": patch
---

Add `DurableObjectSqliteEventStore` and `DurableObjectSqliteCheckpointStore`,
the append-only SQLite counterparts to the legacy KV event/checkpoint stores.

Like `DurableObjectSqliteSessionStore`, they persist one small SQLite row per
event / per checkpoint instead of re-writing the whole per-run list into a
single `storage.put` value on every append. A run with many large tool-result
events or full-history checkpoints can no longer cross the Durable Object ~2MB
per-value limit (`SQLITE_TOOBIG`) by accumulation — the failure that surfaced as
`Error: string or blob too big: SQLITE_TOOBIG` on the `afterTool` checkpoint
write after tools such as `web_search`.

`createCloudflareDurableObjectHost` now selects these SQLite stores
automatically when `storage.sql` is available (ChatRoom-style SQLite-backed
Durable Objects), and keeps the legacy KV stores on non-SQLite storage, so no
caller change is required. Event cursors (1-based skip offsets), checkpoint
`stale-version` optimistic checks, and `latest()` semantics are preserved
byte-for-byte. Both new stores are re-exported from
`@minpeter/pss-runtime/cloudflare`.
