---
"@minpeter/pss-runtime": patch
---

Add `DurableObjectSqliteEventStore` and `DurableObjectSqliteCheckpointStore`,
the append-only SQLite stores used by the Cloudflare Durable Object host.

Like `DurableObjectSqliteSessionStore`, they persist one small SQLite row per
event / per checkpoint instead of re-writing a whole per-run list into a single
`storage.put` value on every append. A run with many large tool-result events or
full-history checkpoints can no longer cross the Durable Object ~2MB per-value
limit (`SQLITE_TOOBIG`) by accumulation — the failure that surfaced as
`Error: string or blob too big: SQLITE_TOOBIG` on the `afterTool` checkpoint
write after tools such as `web_search`.

`createCloudflareDurableObjectHost` now requires SQLite-backed Durable Object
storage (`storage.sql`) and wires these SQLite stores directly. Event cursors
(1-based skip offsets), checkpoint `stale-version` optimistic checks, and
`latest()` semantics are preserved. Both stores are re-exported from
`@minpeter/pss-runtime/cloudflare`.
