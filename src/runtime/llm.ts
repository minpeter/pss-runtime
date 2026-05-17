import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  jsonSchema,
  tool,
  type LanguageModel,
} from "ai";
import { env } from "./env";
import type { AssistantMessage, ModelHistoryItem, ToolMessage } from "./session/events";

export type LlmOutputPart = AssistantMessage | ToolMessage;
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

export function createLlm({
  model = defaultModel,
  instructions,
}: CreateLlmOptions = {}): Llm {
  return async ({ history, signal }) => {
    const result = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      tools: continueTools,
    });

    return result.responseMessages;
  };
}
