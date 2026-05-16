import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop";
import type { AgentEvent } from "./events";
import type { Llm, LlmOutput } from "./mock-llm";

const createScriptedLlm = (outputs: LlmOutput[]): Llm => {
  let index = 0;
  return async () => outputs[index++] ?? [];
};

const events: AgentEvent[] = [];
const llm = createScriptedLlm([
  [
    { type: "text", text: "I should keep going." },
    { type: "tool-call", toolName: "continue" },
  ],
  [{ type: "text", text: "DONE" }],
]);

assert.equal(await runAgentLoop({ emit: (event) => events.push(event), llm }), undefined);
assert.deepEqual(
  events.map((event) => event.type),
  [
    "agent-start",
    "turn-start",
    "text",
    "tool-call",
    "turn-end",
    "turn-start",
    "text",
    "turn-end",
    "agent-end",
  ]
);
