---
"@minpeter/pss-runtime": minor
---

Collapse host types to a single `AgentHost` with `HostStore`, `HostScheduler`, and optional `HostAttachmentStore`; rename platform factories to `createInMemoryHost` / `createFileHost` / `createCloudflareHost`; make Cloudflare product path Agents-only (`createCloudflarePlatformContext`, fibers/schedule) and remove the DO alarm drain stack; expose low-level `createCloudflareStorageHost` / queue scheduler for tooling; and remove `ThreadHost` / `DurableBackgroundHost` / host `kind` fields.
