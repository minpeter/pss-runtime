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
  const prompt = promptForModel({ history, instructions });
  const { responseMessages } = await generateText({
    abortSignal: signal,
    instructions: prompt.instructions,
    messages: prompt.messages,
    model,
    toolChoice,
    tools: normalizeToolCallIds(tools, toolCallIds, toolExecution),
  });

  return responseMessages.map((message) =>
    rewriteMessageToolCallIds(message, toolCallIds)
  );
}

function promptForModel({
  history,
  instructions,
}: {
  readonly history: readonly ModelMessage[];
  readonly instructions?: string;
}): {
  readonly instructions?: string;
  readonly messages: ModelMessage[];
} {
  const messages: ModelMessage[] = [];
  const systemContents: string[] = instructions ? [instructions] : [];
  for (const message of history) {
    if (message.role === "system") {
      systemContents.push(systemContentText(message.content));
      continue;
    }
    messages.push(message);
  }

  return {
    ...(systemContents.length === 0
      ? {}
      : { instructions: systemContents.join("\n\n") }),
    messages,
  };
}

function systemContentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}
