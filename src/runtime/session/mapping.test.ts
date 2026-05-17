import assert from "node:assert/strict";
import type { AssistantModelMessage, ToolCallPart, ToolModelMessage } from "ai";
import type { UserText } from "./events";
import { modelMessageToAgentEvents, userTextToModelMessage } from "./mapping";

const userText = (text: string): UserText => ({ type: "user-text", text });

const assistantMessage = (
  content: AssistantModelMessage["content"]
): AssistantModelMessage => ({
  role: "assistant",
  content,
});

const continueToolCall = (toolCallId: string): ToolCallPart => ({
  type: "tool-call",
  toolCallId,
  toolName: "continue",
  input: {},
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

assert.deepEqual(userTextToModelMessage(userText("hello")), {
  role: "user",
  content: "hello",
});

assert.deepEqual(modelMessageToAgentEvents(assistantMessage("DONE")), [
  { type: "assistant-text", text: "DONE" },
]);

const toolCall = continueToolCall("call-continue");
assert.deepEqual(
  modelMessageToAgentEvents(
    assistantMessage([
      { type: "text", text: "thinking aloud" },
      { type: "text", text: "" },
      toolCall,
    ])
  ),
  [
    { type: "assistant-text", text: "thinking aloud" },
    { type: "tool-call", toolName: "continue" },
  ]
);

assert.deepEqual(
  modelMessageToAgentEvents(userTextToModelMessage(userText("hi"))),
  []
);
assert.deepEqual(modelMessageToAgentEvents(continueToolResult(toolCall)), []);
