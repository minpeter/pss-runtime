import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEvent } from "./session/agent-events";
import type {
  AssistantModelMessage,
  ModelMessage,
  ToolCallPart,
  ToolModelMessage,
} from "ai";

const createScriptedLlm = (outputs: LlmOutput[]): Llm => {
  let index = 0;
  return async () => outputs[index++] ?? [];
};

const continueToolCall = (toolCallId: string): ToolCallPart => ({
  type: "tool-call",
  toolCallId,
  toolName: "continue",
  input: {},
});

const assistantMessage = (
  content: AssistantModelMessage["content"]
): AssistantModelMessage => ({
  role: "assistant",
  content,
});

const continueToolResult = (toolCall: ToolCallPart): ToolModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: { type: "json", value: {} },
    },
  ],
});

const events: AgentEvent[] = [];
const history: ModelMessage[] = [];
const callContinue1 = continueToolCall("call-continue-1");
const llm = createScriptedLlm([
  [
    assistantMessage([
      { type: "text", text: "I should keep going." },
      callContinue1,
    ]),
    continueToolResult(callContinue1),
  ],
  [assistantMessage("DONE")],
]);

assert.equal(
  await runAgentLoop({ emit: (event) => events.push(event), history, llm }),
  "completed"
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
assert.deepEqual(events, [
  { type: "step-start" },
  { type: "assistant-text", text: "I should keep going." },
  { type: "tool-call", toolName: "continue" },
  { type: "step-end" },
  { type: "step-start" },
  { type: "assistant-text", text: "DONE" },
  { type: "step-end" },
]);
assert.deepEqual(history, [
  assistantMessage([{ type: "text", text: "I should keep going." }, callContinue1]),
  continueToolResult(callContinue1),
  assistantMessage("DONE"),
]);

const abortEvents: AgentEvent[] = [];
const abortHistory: ModelMessage[] = [];
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
  "aborted"
);
assert.deepEqual(
  abortEvents.map((event) => event.type),
  ["step-start"]
);
assert.deepEqual(abortHistory, []);
