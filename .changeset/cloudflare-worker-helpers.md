---
"@minpeter/pss-runtime": patch
---

Add small Cloudflare worker helpers for Durable Object wiring and run-event
draining. The `@minpeter/pss-runtime/cloudflare` subpath now exports
Durable Object state/namespace/stub shape types and lets `drainAgentRun`
observe each event while collecting the drained event list.
