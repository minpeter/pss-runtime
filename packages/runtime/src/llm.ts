import type {
  LanguageModel,
  ModelMessage,
  Tool,
  ToolExecutionOptions,
  ToolSet,
} from "ai";
import { generateText } from "ai";

export type AgentToolExecutionOptions = ToolExecutionOptions<unknown>;
export type AgentToolExecute = NonNullable<Tool["execute"]>;
export type AgentTool = Tool;
export type AgentTools = ToolSet;
export type AgentModel = LanguageModel;
export type AgentMessage = ModelMessage;
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
