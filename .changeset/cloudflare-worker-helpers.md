---
"@minpeter/pss-runtime": patch
---

Add Cloudflare Worker helpers for Durable Object wiring, agent context creation,
budgeted alarm draining, and run-event draining. The
`@minpeter/pss-runtime/cloudflare` subpath now exports Durable Object
state/namespace/stub shape types, `fetchCloudflareDurableObject`,
`createCloudflareAgentContext`, alarm drain budgets with continuation re-arm
summaries, and event-drain helpers for Worker adapters.
Alarm drains now apply finite default budgets and stop inside a resumed run when
the event or deadline budget is exhausted, leaving scheduled work queued for the
next alarm instead of ACKing partially drained work.

The runtime root also exports AgentEvent classifier helpers such as
`isVisibleAgentEvent`, `isLifecycleAgentEvent`, `isToolAgentEvent`, and
`isSubagentStatusAgentEvent` so apps can split public transcript events from
control and telemetry events without hand-rolling `event.type` switches.
