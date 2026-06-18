---
"@minpeter/pss-runtime": patch
---

Add `DurableObjectSqliteSessionStore`, an append-only session store for
SQLite-backed Durable Objects, and make the Cloudflare Durable Object host use it
by default. It persists conversation history as one small SQLite row per message
(delta-append on commit, reconstruct on load) instead of re-serializing the
entire snapshot into a single `storage.put` value every turn, so long sessions no
longer cross the Durable Object ~2MB per-value limit (`SQLITE_TOOBIG`).
Rollbacks soft-delete trailing rows and optimistic version/conflict semantics are
preserved.

`createCloudflareDurableObjectHost` now requires SQLite-backed Durable Object
storage (`storage.sql`). Callers can still pass `sessionStore` when they need to
provide a custom session store.
