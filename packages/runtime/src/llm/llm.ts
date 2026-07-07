import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from "ai";
import { generateText } from "ai";
import {
  hydrateRuntimeAttachments,
  type RuntimeAttachmentStore,
} from "../thread/input/attachments";
import { assertNoUnsupportedToolApproval } from "./tool-approval";
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

export interface ModelContextTokenEstimateInput {
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
}

export interface ModelContextGateOptions {
  readonly bufferTokens?: number;
  readonly estimateTokens?: (input: ModelContextTokenEstimateInput) => number;
  readonly maxInputTokens: number;
  readonly onOverflow?: "compact" | "error";
}

export class ContextBudgetExceededError extends Error {
  readonly bufferTokens: number;
  readonly estimatedTokens: number;
  readonly maxInputTokens: number;
  readonly name = "ContextBudgetExceededError";
  readonly onOverflow: "compact" | "error";

  constructor({
    bufferTokens,
    estimatedTokens,
    maxInputTokens,
    onOverflow,
  }: {
    readonly bufferTokens: number;
    readonly estimatedTokens: number;
    readonly maxInputTokens: number;
    readonly onOverflow: "compact" | "error";
  }) {
    super(
      `context gate rejected prompt: estimated ${estimatedTokens} input tokens plus ${bufferTokens} reserved tokens exceeds maxInputTokens ${maxInputTokens}.`
    );
    this.bufferTokens = bufferTokens;
    this.estimatedTokens = estimatedTokens;
    this.maxInputTokens = maxInputTokens;
    this.onOverflow = onOverflow;
  }
}

export interface ModelGenerationOptions {
  attachmentStore?: RuntimeAttachmentStore;
  contextGate?: false | ModelContextGateOptions;
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
  attachmentStore,
  contextGate,
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
  const messages = await hydrateRuntimeAttachments(
    prompt.messages,
    attachmentStore
  );
  enforceContextGate({
    contextGate,
    instructions: prompt.instructions,
    messages,
  });
  assertNoUnsupportedToolApproval(tools);
  const { responseMessages } = await generateText({
    abortSignal: signal,
    instructions: prompt.instructions,
    messages,
    model,
    toolChoice,
    tools: normalizeToolCallIds(tools, toolCallIds, toolExecution),
  });

  return responseMessages.map((message) =>
    rewriteMessageToolCallIds(message, toolCallIds)
  );
}

function enforceContextGate({
  contextGate,
  instructions,
  messages,
}: {
  readonly contextGate?: false | ModelContextGateOptions;
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
}): void {
  if (!contextGate) {
    return;
  }

  const bufferTokens = contextGate.bufferTokens ?? 0;
  const estimatedTokens = estimatePromptTokens(
    { instructions, messages },
    contextGate.estimateTokens
  );
  if (estimatedTokens + bufferTokens <= contextGate.maxInputTokens) {
    return;
  }

  throw new ContextBudgetExceededError({
    bufferTokens,
    estimatedTokens,
    maxInputTokens: contextGate.maxInputTokens,
    onOverflow: contextGate.onOverflow ?? "compact",
  });
}

function estimatePromptTokens(
  input: ModelContextTokenEstimateInput,
  estimator: ModelContextGateOptions["estimateTokens"]
): number {
  if (estimator) {
    return estimator(input);
  }

  const serialized = JSON.stringify(
    {
      instructions: input.instructions,
      messages: input.messages,
    },
    promptTokenEstimateReplacer
  );
  return Math.ceil(serialized.length / 4);
}

function promptTokenEstimateReplacer(_key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return binaryPromptTokenEstimate(value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return binaryPromptTokenEstimate(value.byteLength);
  }
  return value;
}

function binaryPromptTokenEstimate(byteLength: number): {
  readonly byteLength: number;
  readonly type: "binary";
} {
  return { byteLength, type: "binary" };
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
