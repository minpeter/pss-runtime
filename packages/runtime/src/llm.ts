import type { LanguageModel, ModelMessage } from "ai";
import { generateText, type ToolSet } from "ai";

export interface AgentToolExecutionOptions {
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

export type AgentToolExecute = unknown;

export interface AgentTool {
  description?: unknown;
  execute?: AgentToolExecute;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export type AgentTools = Record<string, AgentTool>;
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
  model: LanguageModel;
  tools?: AgentTools;
}

export type RuntimeCreateLlmOptions = CreateLlmOptions;
export type RuntimeLlm = Llm;
export type RuntimeLlmContext = LlmContext;
export type RuntimeLlmOutput = LlmOutput;

export function createLlm({
  model,
  instructions,
  tools,
}: CreateLlmOptions): Llm {
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
