import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop";
import type { AgentEvent } from "./events";
import { createMockLlm } from "./mock-llm";

assert.deepEqual(await createMockLlm(() => 0.29)(), {
  type: "text",
  text: "DONE",
});
assert.deepEqual(await createMockLlm(() => 0.3)(), {
  type: "tool-call",
  toolName: "continue",
});

const events: AgentEvent[] = [];
const originalRandom = Math.random;
let calls = 0;
Math.random = () => {
  calls += 1;
  return calls === 1 ? 0.7 : 0.2;
};
try {
  assert.equal(await runAgentLoop((event) => events.push(event)), "DONE");
} finally {
  Math.random = originalRandom;
}
assert.equal(calls, 2);
assert.deepEqual(
  events.map((event) => event.type),
  [
    "agent_start",
    "turn_start",
    "tool_call",
    "turn_end",
    "turn_start",
    "message",
    "turn_end",
    "agent_end",
  ]
);
