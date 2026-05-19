import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { env } from "./env";

export type AgentTools = ToolSet;
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
  tools?: AgentTools;
}

const defaultProvider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

export const defaultModel = defaultProvider(env.AI_MODEL);

export function createLlm({
  model = defaultModel,
  instructions,
  tools,
}: CreateLlmOptions = {}): Llm {
  return async ({ history, signal }) => {
    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      tools,
    });

    return responseMessages;
  };
}
