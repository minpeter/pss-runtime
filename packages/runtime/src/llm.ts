import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from "ai";
import { generateText } from "ai";
import type { RuntimeToolExecutionContext } from "./llm-tool-execution";
import {
  normalizeToolCallIds,
  rewriteMessageToolCallIds,
} from "./llm-tool-execution";

export type {
  RuntimePersistedToolExecutionCheckpoint,
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionCheckpointMetadata,
  RuntimeToolExecutionContext,
  RuntimeToolExecutionDecision,
  RuntimeToolRetryPolicy,
} from "./llm-tool-execution";

export type AgentToolChoice = ToolChoice<ToolSet>;
export type RuntimeLlmOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type RuntimeLlmOutputPart = RuntimeLlmOutput[number];

export interface RuntimeLlmContext {
  history: readonly ModelMessage[];
  signal: AbortSignal;
  toolExecution?: RuntimeToolExecutionContext;
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
  return async ({ history, signal, toolExecution }) => {
    const toolCallIds = new Map<string, string>();
    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      toolChoice,
      tools: normalizeToolCallIds(tools, toolCallIds, toolExecution),
    });

    return responseMessages.map((message) =>
      rewriteMessageToolCallIds(message, toolCallIds)
    );
  };
}
