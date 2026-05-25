---
"@minpeter/pss-runtime": patch
"@minpeter/pss-coding-agent": patch
---

Replace the public current-turn input API with `session.steer(input)` and keep
`session.send(input)` as the new-turn queue. Active TUI submissions now steer the
current run through the session API.
