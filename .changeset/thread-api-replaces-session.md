---
"@minpeter/pss-runtime": patch
"@minpeter/pss-coding-agent": patch
---

Replace the public `agent.session(key)` entrypoint with `agent.thread(key)`.
Threads are the app-facing conversation unit; runtime session state remains an
internal storage concern behind the thread handle. `agent.thread({ key, scope })`
now provides an optional scoped address for multi-user integrations while
preserving opaque session storage under the host boundary.

Rename execution, Cloudflare scheduling, and notification APIs from
`sessionKey`/`resumeSession`/scheduled session prompts to
`threadKey`/`resumeThread`/scheduled thread prompts so edge apps can model
linear conversation history without leaking storage-session terminology.
