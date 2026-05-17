import type {
  AssistantContent,
  AssistantModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import type { AgentEvent, ModelHistoryItem, UserText } from "./events";

type AssistantContentPart = Exclude<AssistantContent, string>[number];
type ResponseMessage = AssistantModelMessage | ToolModelMessage;

export function toUserModelMessage(input: UserText): UserModelMessage {
  return { role: "user", content: input.text };
}

export function agentEventsFromResponseMessage(
  message: ResponseMessage
): ModelHistoryItem[] {
  if (message.role === "tool") {
    return [];
  }

  return assistantContentParts(message).flatMap((part): ModelHistoryItem[] => {
    if (part.type === "text") {
      return part.text ? [{ type: "assistant-text", text: part.text }] : [];
    }

    if (part.type === "tool-call") {
      return [{ type: "tool-call", toolName: part.toolName }];
    }

    return [];
  });
}

export function hasAssistantToolCall(message: AssistantModelMessage): boolean {
  return assistantContentParts(message).some((part) => part.type === "tool-call");
}

export function isModelHistoryItem(event: AgentEvent): event is ModelHistoryItem {
  return (
    event.type === "user-text" ||
    event.type === "assistant-text" ||
    event.type === "tool-call"
  );
}

function assistantContentParts(message: AssistantModelMessage): AssistantContentPart[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}
