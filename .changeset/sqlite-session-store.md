---
"@minpeter/pss-runtime": patch
---

Add `DurableObjectSqliteSessionStore`, an append-only session store for
SQLite-backed Durable Objects. It persists conversation history as one small
SQLite row per message (delta-append on commit, reconstruct on load) instead of
re-serializing the entire snapshot into a single `storage.put` value every turn,
so long sessions no longer cross the Durable Object ~2MB per-value limit
(`SQLITE_TOOBIG`). Rollbacks soft-delete the trailing rows, the optimistic
version/conflict semantics are preserved byte-for-byte, and any pre-existing
`storage.put` snapshot is lazily migrated into rows on first access. Opt in via
the existing `sessionStore` option of `createCloudflareDurableObjectHost`; the
default store is unchanged.
