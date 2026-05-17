import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  tool,
} from "ai";
import { env } from "./env";

export type LlmOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type LlmOutputPart = LlmOutput[number];
export interface LlmContext {
  history: readonly ModelMessage[];
  signal: AbortSignal;
}
export type Llm = (context: LlmContext) => Promise<LlmOutput>;

export interface CreateLlmOptions {
  instructions?: string;
  model?: LanguageModel;
}

const defaultProvider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

export const defaultModel = defaultProvider(env.AI_MODEL);

const continueTool = tool({
  description:
    "Request one more agent loop step before producing a final answer.",
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
    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      tools: continueTools,
    });

    return responseMessages;
  };
}
