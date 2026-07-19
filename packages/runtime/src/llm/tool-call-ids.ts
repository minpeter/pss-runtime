import type { AssistantModelMessage, ToolModelMessage } from "ai";
import type { ModelStepOutput } from "./model-step-types";

const toolCallIdPrefix = "call_";
const publicToolCallIdPattern = /^call[-_]/;

type ModelStepMessage = ModelStepOutput[number];

export function rewriteMessageToolCallIds(
  message: ModelStepMessage,
  toolCallIds: Map<string, string>
): ModelStepMessage {
  if (message.role === "assistant") {
    return rewriteAssistantToolCallIds(message, toolCallIds);
  }

  if (message.role === "tool") {
    return rewriteToolResultCallIds(message, toolCallIds);
  }

  return message;
}

function rewriteAssistantToolCallIds(
  message: AssistantModelMessage,
  toolCallIds: Map<string, string>
): AssistantModelMessage {
  if (typeof message.content === "string") {
    return message;
  }

  return {
    ...message,
    content: message.content.map((part) =>
      "toolCallId" in part
        ? {
            ...part,
            toolCallId: publicToolCallId(part.toolCallId, toolCallIds),
          }
        : part
    ),
  };
}

function rewriteToolResultCallIds(
  message: ToolModelMessage,
  toolCallIds: Map<string, string>
): ToolModelMessage {
  return {
    ...message,
    content: message.content.map((part) =>
      "toolCallId" in part
        ? {
            ...part,
            toolCallId: publicToolCallId(part.toolCallId, toolCallIds),
          }
        : part
    ),
  };
}

export function publicToolCallId(
  toolCallId: string,
  toolCallIds: Map<string, string>
): string {
  if (publicToolCallIdPattern.test(toolCallId)) {
    return toolCallId;
  }

  const existing = toolCallIds.get(toolCallId);
  if (existing) {
    return existing;
  }

  const generated = createToolCallId();
  toolCallIds.set(toolCallId, generated);
  return generated;
}

function createToolCallId(): string {
  return `${toolCallIdPrefix}${crypto.randomUUID().replaceAll("-", "")}`;
}
