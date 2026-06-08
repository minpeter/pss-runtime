---
"@minpeter/pss-runtime": patch
---

Add Cloudflare Worker helpers for Durable Object wiring, agent context creation,
alarm draining, and run-event draining. The `@minpeter/pss-runtime/cloudflare`
subpath now exports Durable Object state/namespace/stub shape types,
`fetchCloudflareDurableObject`, `createCloudflareAgentContext`, and event-drain
helpers for Worker adapters.
