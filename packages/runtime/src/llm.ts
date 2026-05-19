import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, ModelMessage } from "ai";
import { generateText, type ToolSet } from "ai";
import { env } from "./env";

export type AgentTools = Record<string, unknown>;
export type AgentModel = LanguageModel;
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

export type RuntimeCreateLlmOptions = CreateLlmOptions;
export type RuntimeLlm = Llm;
export type RuntimeLlmContext = LlmContext;
export type RuntimeLlmOutput = LlmOutput;

const defaultProvider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

export const defaultModel: LanguageModel = defaultProvider(env.AI_MODEL);

export function createLlm({
  model = defaultModel,
  instructions,
  tools,
}: CreateLlmOptions = {}): Llm {
  const runtimeTools = tools as ToolSet | undefined;

  return async ({ history, signal }) => {
    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      tools: runtimeTools,
    });

    return responseMessages;
  };
}
