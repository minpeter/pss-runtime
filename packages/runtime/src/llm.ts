import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { generateText } from "ai";

export type AgentToolChoice = "auto" | "required";
export type RuntimeLlmOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type RuntimeLlmOutputPart = RuntimeLlmOutput[number];

export interface RuntimeLlmContext {
  history: readonly ModelMessage[];
  signal: AbortSignal;
}

export type RuntimeLlm = (
  context: RuntimeLlmContext
) => Promise<RuntimeLlmOutput>;

export interface RuntimeCreateLlmOptions {
  instructions?: string;
  model: LanguageModel;
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

export function createLlm({
  model,
  instructions,
  toolChoice,
  tools,
}: RuntimeCreateLlmOptions): RuntimeLlm {
  return async ({ history, signal }) => {
    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      toolChoice,
      tools,
    });

    return responseMessages;
  };
}
