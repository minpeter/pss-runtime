import type {
  AssistantContent,
  AssistantModelMessage,
  ModelMessage,
  UserModelMessage,
} from "ai";
import type { AssistantText, ToolCall, UserText } from "./events";

type AssistantContentPart = Exclude<AssistantContent, string>[number];
type AssistantEvent = AssistantText | ToolCall;

// UserText -> AI SDK UserModelMessage
export function userTextToModelMessage(input: UserText): UserModelMessage {
  return { role: "user", content: input.text };
}

// AI SDK ModelMessage -> public agent events
export function modelMessageToAgentEvents(
  message: ModelMessage
): AssistantEvent[] {
  if (message.role !== "assistant") {
    return [];
  }

  return assistantContentParts(message).flatMap((part): AssistantEvent[] => {
    if (part.type === "text") {
      return part.text ? [{ type: "assistant-text", text: part.text }] : [];
    }

    if (part.type === "tool-call") {
      return [{ type: "tool-call", toolName: part.toolName }];
    }

    return [];
  });
}

function assistantContentParts(
  message: AssistantModelMessage
): AssistantContentPart[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}
