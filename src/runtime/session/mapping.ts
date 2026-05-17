import type {
  AssistantContent,
  AssistantModelMessage,
  ModelMessage,
  UserModelMessage,
} from "ai";
import type { ModelHistoryItem } from "./events";

type AssistantContentPart = Exclude<AssistantContent, string>[number];

export function agentEventsFromModelMessage(
  message: ModelMessage
): ModelHistoryItem[] {
  if (message.role === "user") {
    const text = userTextContent(message);
    return text ? [{ type: "user-text", text }] : [];
  }

  if (message.role !== "assistant") {
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

function userTextContent(message: UserModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assistantContentParts(message: AssistantModelMessage): AssistantContentPart[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}
