import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  jsonSchema,
  tool,
  type ContentPart,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import { env } from "./env";
import type { AssistantText, ModelHistoryItem, ToolCall } from "./session/events";

type AssistantPromptPart = TextPart | ToolCallPart;

export type LlmOutputPart = AssistantText | ToolCall;
export type LlmOutput = LlmOutputPart[];
export type LlmContext = {
  history: readonly ModelHistoryItem[];
  signal: AbortSignal;
};
export type Llm = (context: LlmContext) => Promise<LlmOutput>;

export type CreateLlmOptions = {
  model?: LanguageModel;
  instructions?: string;
};

const defaultProvider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

export const defaultModel = defaultProvider(env.AI_MODEL);

const continueTool = tool({
  description: "Request one more agent loop step before producing a final answer.",
  execute: () => ({}),
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

const continueTools = { continue: continueTool };
type ContinueContentPart = ContentPart<typeof continueTools>;

export function createLlm({
  model = defaultModel,
  instructions,
}: CreateLlmOptions = {}): Llm {
  return async ({ history, signal }) => {
    const result = await generateText({
      abortSignal: signal,
      instructions,
      messages: toModelMessages(history),
      model,
      tools: continueTools,
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
      assistantParts.push({ type: "text", text: item.text } satisfies TextPart);
      return;
    }

    assistantParts.push(item);
    flushAssistant();
    const toolResultPart = {
      type: "tool-result",
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      output: { type: "json", value: {} },
    } satisfies ToolResultPart;

    messages.push({
      role: "tool",
      content: [toolResultPart],
    });
  });

  flushAssistant();
  return messages;
}

function toLlmOutput(content: ContinueContentPart[]): LlmOutput {
  return content.flatMap((part): LlmOutput => {
    if (part.type === "text") {
      return part.text ? [{ type: "assistant-text", text: part.text }] : [];
    }

    if (part.type === "tool-call") {
      return [
        {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          providerExecuted: part.providerExecuted,
        },
      ];
    }

    return [];
  });
}
