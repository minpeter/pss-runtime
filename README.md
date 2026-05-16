# pss-next

Small prototype for a minimal agent runtime: a mock LLM emits text, a tool call, or text followed by a tool call; sessions accept user messages through a queue and consumers observe progress through agent events.

Sessions own raw history. The event log records every emitted event, while model history records the smaller sequence passed back into the LLM. A session snapshot can be saved, restored, or viewed at an earlier sequence for time-travel-style inspection.

```bash
pnpm install
pnpm run dev
pnpm run test
pnpm run typecheck
```
