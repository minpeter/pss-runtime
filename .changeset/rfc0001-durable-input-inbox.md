---
"@minpeter/pss-runtime": patch
---

Add a durable `ThreadInputInbox` execution-store port with memory, file, and Cloudflare storage implementations, and wire runtime send/steer admission through durable input claim, promote, ack, release, recovery, and context-overflow compaction boundaries.
