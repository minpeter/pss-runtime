import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from "ai";
import { generateText } from "ai";
import type { RuntimeToolExecutionContext } from "./tool-execution";
import {
  normalizeToolCallIds,
  rewriteMessageToolCallIds,
} from "./tool-execution";

export type {
  RuntimePersistedToolExecutionCheckpoint,
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionCheckpointMetadata,
  RuntimeToolExecutionContext,
  RuntimeToolExecutionDecision,
  RuntimeToolRetryPolicy,
} from "./tool-execution";

export type AgentToolChoice = ToolChoice<ToolSet>;
export type ModelStepOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type ModelStepOutputPart = ModelStepOutput[number];

export interface ModelGenerationOptions {
  instructions?: string;
  model: LanguageModel;
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

export interface ModelStepOptions extends ModelGenerationOptions {
  history: readonly ModelMessage[];
  signal: AbortSignal;
  toolExecution?: RuntimeToolExecutionContext;
}

export async function generateModelStep({
  history,
  model,
  instructions,
  signal,
  toolChoice,
  toolExecution,
  tools,
}: ModelStepOptions): Promise<ModelStepOutput> {
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
}
