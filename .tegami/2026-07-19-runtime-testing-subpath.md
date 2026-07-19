---
packages:
  "npm:@minpeter/pss-runtime": minor
---

## Expose AgentTurn test helpers via the `./testing` subpath

`@minpeter/pss-runtime/testing` is now a public subpath for downstream tests
that consume `AgentTurn.events()`:

- `createMockAgentTurn(events)` builds an `AgentTurn` from an `AgentEvent`
  array or an `AsyncIterable<AgentEvent>`. Like a real turn, `events()` is
  single-consumption and throws on a second call.
- `agentEventStream(events)` replays an event array as a deterministic async
  iterable.
- `agentEvent` provides typed builders for public event payloads:
  `assistantOutput`, `assistantReasoning`, `toolCall`, `toolResult`,
  `stepStart` / `stepEnd`, the `turn-*` lifecycle events, and `userText` /
  `userMessage`.

Internal fixtures stay unexported; the subpath surface is only the helpers
above, so downstream mocks no longer drift when event names or turn APIs
change.
