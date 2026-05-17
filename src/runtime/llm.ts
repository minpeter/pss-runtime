import {
  generateText,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import type { AssistantText, ModelHistoryItem, ToolCall } from "./session/events";

type AssistantPromptPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: object };

export type LlmOutputPart = AssistantText | ToolCall;
export type LlmOutput = LlmOutputPart[];
export type LlmContext = {
  history: readonly ModelHistoryItem[];
  signal: AbortSignal;
};
export type Llm = (context: LlmContext) => Promise<LlmOutput>;

export type CreateLlmOptions = {
  model: LanguageModel;
  instructions?: string;
};

const continueTool = tool({
  description: "Request one more agent loop step before producing a final answer.",
  inputSchema: jsonSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  outputSchema: jsonSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
});

export function createLlm({ model, instructions }: CreateLlmOptions): Llm {
  return async ({ history, signal }) => {
    const result = await generateText({
      abortSignal: signal,
      instructions,
      messages: toModelMessages(history),
      model,
      tools: { continue: continueTool },
    });

    return toLlmOutput(result.content);
  };
}

function toModelMessages(history: readonly ModelHistoryItem[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let assistantParts: AssistantPromptPart[] = [];

  const flushAssistant = () => {
    if (assistantParts.length === 0) {
      return;
    }

    messages.push({
      role: "assistant",
      content:
        assistantParts.length === 1 && assistantParts[0]?.type === "text"
          ? assistantParts[0].text
          : assistantParts,
    });
    assistantParts = [];
  };

  history.forEach((item, index) => {
    if (item.type === "user-text") {
      flushAssistant();
      messages.push({ role: "user", content: item.text });
      return;
    }

    if (item.type === "assistant-text") {
      assistantParts.push({ type: "text", text: item.text });
      return;
    }

    const toolCallId = `tool-call-${index}`;
    assistantParts.push({
      type: "tool-call",
      toolCallId,
      toolName: item.toolName,
      input: {},
    });
    flushAssistant();
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: item.toolName,
          output: { type: "json", value: {} },
        },
      ],
    });
  });

  flushAssistant();
  return messages;
}

function toLlmOutput(content: Awaited<ReturnType<typeof generateText>>["content"]): LlmOutput {
  return content.flatMap((part): LlmOutput => {
    if (part.type === "text") {
      return part.text ? [{ type: "assistant-text", text: part.text }] : [];
    }

    if (part.type === "tool-call") {
      return [{ type: "tool-call", toolName: part.toolName }];
    }

    return [];
  });
}
