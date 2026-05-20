import type {
  AssistantContent,
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import type {
  AssistantReasoning,
  AssistantText,
  ToolCall,
  ToolResult,
  UserText,
  UserTextContent,
} from "./events";

type AssistantContentPart = Exclude<AssistantContent, string>[number];
type ToolContentPart = ToolModelMessage["content"][number];
type ModelEvent = AssistantReasoning | AssistantText | ToolCall | ToolResult;

// UserText -> AI SDK UserModelMessage
export function userTextToModelMessage(input: UserText): UserModelMessage {
  return { role: "user", content: userTextContentToUserContent(input.text) };
}

function userTextContentToUserContent(
  text: UserTextContent
): UserModelMessage["content"] {
  if (typeof text === "string") {
    return text;
  }

  return text.map((part) => ({ type: "text", text: part }));
}

// AI SDK ModelMessage -> public agent events
export function modelMessageToAgentEvents(message: ModelMessage): ModelEvent[] {
  if (message.role === "assistant") {
    return assistantReasoningFirstParts(assistantContentParts(message)).flatMap(
      assistantContentPartToEvents
    );
  }

  if (message.role === "tool") {
    return message.content.flatMap(toolContentPartToEvents);
  }

  return [];
}

function assistantContentParts(
  message: AssistantModelMessage
): AssistantContentPart[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

function assistantReasoningFirstParts(
  parts: AssistantContentPart[]
): AssistantContentPart[] {
  return [
    ...parts.filter((part) => part.type === "reasoning"),
    ...parts.filter((part) => part.type !== "reasoning"),
  ];
}

function assistantContentPartToEvents(
  part: AssistantContentPart
): ModelEvent[] {
  if (part.type === "text") {
    return part.text ? [{ type: "assistant-text", text: part.text }] : [];
  }

  if (part.type === "reasoning") {
    return part.text ? [{ type: "assistant-reasoning", text: part.text }] : [];
  }

  if (part.type === "tool-call") {
    return [
      {
        type: "tool-call",
        input: part.input,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      },
    ];
  }

  return [];
}

function toolContentPartToEvents(part: ToolContentPart): ModelEvent[] {
  if (part.type === "tool-result") {
    return toolResultPartToEvents(part);
  }

  return [];
}

function toolResultPartToEvents(part: {
  output: unknown;
  toolCallId: string;
  toolName: string;
  type: "tool-result";
}): ModelEvent[] {
  return [
    {
      type: "tool-result",
      output: part.output,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
    },
  ];
}
