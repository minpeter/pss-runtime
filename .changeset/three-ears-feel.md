---
"@minpeter/pss-runtime": patch
---

Enhance `AgentSession` with state hydration, mutation tracking, and broader TypeScript type exports:

- Add `history` hydration via `SessionOptions` in `Agent.createSession()` and `AgentSession` constructor.
- Introduce `getHistory()` to retrieve the current snapshot of the agent's message history.
- Add `onHistoryChange` lifecycle callback hook to `AgentSession` (and underlying `AgentModelHistory`) to observe and persist serialized mutation-time history snapshots.
- Export `AgentMessage` globally from `@minpeter/pss-runtime` for clean external representation of internal AI SDK message structures.
