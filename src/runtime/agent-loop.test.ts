import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEvent } from "./session/events";
import type { ModelHistoryItem, ToolCall } from "./session";

const createScriptedLlm = (outputs: LlmOutput[]): Llm => {
  let index = 0;
  return async () => outputs[index++] ?? [];
};

const continueToolCall = (toolCallId: string): ToolCall => ({
  type: "tool-call",
  toolCallId,
  toolName: "continue",
  input: {},
});

const events: AgentEvent[] = [];
const history: ModelHistoryItem[] = [];
const llm = createScriptedLlm([
  [
    { type: "assistant-text", text: "I should keep going." },
    continueToolCall("call-continue-1"),
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
  continueToolCall("call-continue-1"),
  { type: "assistant-text", text: "DONE" },
]);

const abortEvents: AgentEvent[] = [];
const abortHistory: ModelHistoryItem[] = [];
const abortController = new AbortController();
const abortingLlm: Llm = async () => {
  abortController.abort();
  throw new Error("model request aborted");
};

assert.equal(
  await runAgentLoop({
    emit: (event) => abortEvents.push(event),
    history: abortHistory,
    llm: abortingLlm,
    signal: abortController.signal,
  }),
  "aborted",
);
assert.deepEqual(
  abortEvents.map((event) => event.type),
  ["step-start"],
);
assert.deepEqual(abortHistory, []);
