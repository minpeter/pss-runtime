---
"@minpeter/pss-runtime": patch
---

Add the `host` execution contract for resumable runs, durable notification
resume, and background subagent capability detection. Advanced execution host,
store, and scheduler contracts are available from
`@minpeter/pss-runtime/execution`, and runtime-originated work can resume through
`Agent.resume(runId)`.

Background subagent handling is now more durable: hosts can advertise background
support, child runs are linked for cleanup/cancellation, killed sessions stop
before cleanup waits, and stale cancelled sibling notifications are filtered
without dropping completed work. The Cloudflare edge example shows one adapter
implementation for Worker/Durable Object scheduling and resume.
