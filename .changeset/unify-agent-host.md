---
"@minpeter/pss-runtime": minor
---

Collapse host types to a single `AgentHost` with `HostStore`, `HostScheduler`, and optional `HostAttachmentStore`; rename platform factories to `createInMemoryHost` / `createFileHost` / `createCloudflareHost`; make Cloudflare product host Agents SDK fibers-only (`createCloudflareStorageHost` for low-level DO store/alarm); and remove `ThreadHost` / `DurableBackgroundHost` / host `kind` fields.
