import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEvent } from "./session/events";
import type { AssistantMessage, ModelHistoryItem, ToolCall, ToolMessage } from "./session";

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

const assistantMessage = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
});

const continueToolResult = (toolCall: ToolCall): ToolMessage => ({
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

const eventKind = (event: AgentEvent): string =>
  "role" in event ? event.role : event.type;

const events: AgentEvent[] = [];
const history: ModelHistoryItem[] = [];
const callContinue1 = continueToolCall("call-continue-1");
const llm = createScriptedLlm([
  [assistantMessage([{ type: "text", text: "I should keep going." }, callContinue1]), continueToolResult(callContinue1)],
  [assistantMessage("DONE")],
]);

assert.equal(
  await runAgentLoop({ emit: (event) => events.push(event), history, llm }),
  "completed",
);
assert.deepEqual(
  events.map(eventKind),
  [
    "step-start",
    "assistant",
    "tool",
    "step-end",
    "step-start",
    "assistant",
    "step-end",
  ]
);
assert.deepEqual(history, [
  assistantMessage([{ type: "text", text: "I should keep going." }, callContinue1]),
  continueToolResult(callContinue1),
  assistantMessage("DONE"),
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
  abortEvents.map(eventKind),
  ["step-start"],
);
assert.deepEqual(abortHistory, []);
