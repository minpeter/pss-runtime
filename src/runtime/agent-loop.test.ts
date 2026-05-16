import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop";
import type { AgentEvent } from "./session/events";
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

assert.equal(await runAgentLoop({ emit: (event) => events.push(event), llm }), "completed");
assert.deepEqual(
  events.map((event) => event.type),
  [
    "step-start",
    "assistant-text",
    "tool-call",
    "step-end",
    "step-start",
    "assistant-text",
    "step-end",
  ]
);
