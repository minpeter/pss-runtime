import type {
  UserMessage,
  UserMessageContent,
  UserText,
  UserTextContent,
} from "../session/protocol/events";

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
