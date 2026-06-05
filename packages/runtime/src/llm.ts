import type {
  LanguageModel,
  ModelMessage,
  Tool,
  ToolExecutionOptions,
  ToolSet,
} from "ai";
import { generateText } from "ai";
import { wrapToolsWithPluginHooks } from "./plugins/tool-hooks";

export type AgentToolExecutionOptions = ToolExecutionOptions<unknown>;
export type AgentToolExecute = NonNullable<Tool["execute"]>;
export type AgentToolChoice = "auto" | "required";
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
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

export type RuntimeCreateLlmOptions = CreateLlmOptions;
export type RuntimeLlm = Llm;
export type RuntimeLlmContext = LlmContext;
export type RuntimeLlmOutput = LlmOutput;

export function createLlm({
  model,
  instructions,
  toolChoice,
  tools,
}: CreateLlmOptions): Llm {
  return async ({ history, signal }) => {
    const scopedTools = wrapToolsWithPluginHooks({
      history,
      signal,
      tools,
    });
    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      toolChoice,
      tools: scopedTools,
    });

    return responseMessages;
  };
}
