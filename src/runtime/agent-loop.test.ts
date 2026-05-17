import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEvent } from "./session/events";
import type { ModelHistoryItem } from "./session";

const createScriptedLlm = (outputs: LlmOutput[]): Llm => {
  let index = 0;
  return async () => outputs[index++] ?? [];
};

const events: AgentEvent[] = [];
const history: ModelHistoryItem[] = [];
const llm = createScriptedLlm([
  [
    { type: "assistant-text", text: "I should keep going." },
    { type: "tool-call", toolName: "continue" },
  ],
  [{ type: "assistant-text", text: "DONE" }],
]);

assert.equal(
  await runAgentLoop({ emit: (event) => events.push(event), history, llm }),
  "completed",
);
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
assert.deepEqual(history, [
  { type: "assistant-text", text: "I should keep going." },
  { type: "tool-call", toolName: "continue" },
  { type: "assistant-text", text: "DONE" },
]);
