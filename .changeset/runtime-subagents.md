---
"@minpeter/pss-runtime": patch
---

Replace the async Agent factory with direct construction and keep delegation
app-owned through ordinary tools, sessions, and host-owned background runs.
Runtime-owned subagent APIs and built-in delegation tools are not shipped; see
the sync and background example packages for blocking and background
delegation patterns.
