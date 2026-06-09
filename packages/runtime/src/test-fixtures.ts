import type { AssistantModelMessage, ToolCallPart, ToolModelMessage } from "ai";
import type { RuntimeLlm, RuntimeLlmOutput } from "./llm";
import type {
  AgentEvent,
  UserMessage,
  UserMessageContent,
  UserText,
  UserTextContent,
} from "./session/events";

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

export const createScriptedLlm = (outputs: RuntimeLlmOutput[]): RuntimeLlm => {
  let index = 0;
  return () => Promise.resolve(outputs[index++] ?? []);
};

export const eventTypes = (events: AgentEvent[]) =>
  events.map((event) => event.type);

export const userText = (text: UserTextContent): UserText => ({
  type: "user-text",
  text,
});

export const sentUserText = (text: UserTextContent): UserText => ({
  meta: { source: "send" },
  text,
  type: "user-text",
});

export const userMessage = (content: UserMessageContent): UserMessage => ({
  type: "user-message",
  content,
});

export const sentUserMessage = (content: UserMessageContent): UserMessage => ({
  content,
  meta: { source: "send" },
  type: "user-message",
});

export const steerRuntimeInput = (
  text: UserTextContent,
  placement: "step-end" | "step-start" | "turn-start"
) => ({
  input: {
    meta: { source: "steer", streaming: "steer" as const },
    text,
    type: "user-text" as const,
  },
  meta: { source: "steer" as const, streaming: "steer" as const },
  placement,
  type: "runtime-input" as const,
});

export const notifyRuntimeInput = (
  text: UserTextContent,
  placement: "step-end" | "step-start" | "turn-start" = "turn-start"
) => ({
  input: {
    meta: { source: "notify" as const },
    text,
    type: "user-text" as const,
  },
  meta: { source: "notify" as const },
  placement,
  type: "runtime-input" as const,
});

export const steerRuntimeInputMessage = (
  content: UserMessageContent,
  placement: "step-end" | "step-start" | "turn-start"
) => ({
  input: {
    content,
    meta: { source: "steer" as const, streaming: "steer" as const },
    type: "user-message" as const,
  },
  meta: { source: "steer" as const, streaming: "steer" as const },
  placement,
  type: "runtime-input" as const,
});
