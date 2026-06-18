---
"@minpeter/pss-runtime": patch
---

Rename execution, Cloudflare scheduling, and notification APIs from
`sessionKey`/`resumeSession`/scheduled session prompts to
`threadKey`/`resumeThread`/scheduled thread prompts. Thread keys are now the
public app-facing address for linear conversation history, while existing
storage-session internals remain opaque behind the runtime host boundary.
