---
"@minpeter/pss-runtime": minor
---

Collapse host types to a single `AgentHost`, rename platform factories to `createInMemoryHost` / `createFileHost` / `createCloudflareHost` (Agents SDK or plain DO storage), and remove `ThreadHost` / `DurableBackgroundHost` / host `kind` fields.
