import type { AssistantModelMessage, ToolCallPart, ToolModelMessage } from "ai";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEvent, UserText, UserTextContent } from "./session/events";

export const assistantMessage = (
  content: AssistantModelMessage["content"]
): AssistantModelMessage => ({
  role: "assistant",
  content,
});

export const toolCallPart = (
  toolCallId: string,
  toolName = "test_tool",
  input: unknown = {}
): ToolCallPart => ({
  type: "tool-call",
  toolCallId,
  toolName,
  input,
});

export const toolResultFor = (toolCall: ToolCallPart): ToolModelMessage => ({
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

export const createDeferred = (): {
  promise: Promise<void>;
  resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export const createScriptedLlm = (outputs: LlmOutput[]): Llm => {
  let index = 0;
  return () => Promise.resolve(outputs[index++] ?? []);
};

export const eventTypes = (events: AgentEvent[]) =>
  events.map((event) => event.type);

export const userText = (text: UserTextContent): UserText => ({
  type: "user-text",
  text,
});
