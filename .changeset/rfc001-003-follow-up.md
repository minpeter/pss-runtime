---
"@minpeter/pss-runtime": minor
---

Add durable thread event replay via `thread.events({ after, limit })`, pre-provider context budget gating for automatic compaction, and documentation for durable attachment replay behavior.

Align public multimodal input with AI SDK 7 by removing the deprecated `UserMessageImagePart` / `{ type: "image" }` path. Use `{ type: "file", mediaType: "image" | "image/png", data }` for image inputs.
