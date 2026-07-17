import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ToolChoice,
  ToolSet,
} from "ai";
import { generateText } from "ai";
import {
  type HostAttachmentStore,
  hydrateRuntimeAttachments,
} from "../thread/input/attachments";
import type { ModelUsage } from "../thread/protocol/events";
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
  RuntimeToolExecutionResult,
  RuntimeToolRetryPolicy,
} from "./tool-execution";

export type AgentToolChoice = ToolChoice<ToolSet>;
export type ModelStepOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type ModelStepOutputPart = ModelStepOutput[number];

export interface ModelStepResult {
  readonly messages: ModelStepOutput;
  readonly usage: ModelUsage;
}

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
  attachmentStore?: HostAttachmentStore;
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

const SAFE_TELEMETRY_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const FINISH_REASONS = new Set<ModelUsage["finishReason"]>([
  "content-filter",
  "error",
  "length",
  "other",
  "stop",
  "tool-calls",
]);

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
  return (
    await generateModelStepResult({
      attachmentStore,
      contextGate,
      history,
      instructions,
      model,
      signal,
      toolChoice,
      toolExecution,
      tools,
    })
  ).messages;
}

/**
 * Generate one model step while retaining the provider's normalized usage.
 * Runtime turn loops use this form to expose cache telemetry; callers that
 * only need messages can keep using {@link generateModelStep}.
 */
export async function generateModelStepResult({
  attachmentStore,
  contextGate,
  history,
  model,
  instructions,
  signal,
  toolChoice,
  toolExecution,
  tools,
}: ModelStepOptions): Promise<ModelStepResult> {
  const attemptId = crypto.randomUUID();
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
  const { finalStep, finishReason, response, responseMessages, usage } =
    await generateText({
      abortSignal: signal,
      instructions: prompt.instructions,
      messages,
      model,
      toolChoice,
      tools: normalizeToolCallIds(tools, toolCallIds, toolExecution),
    });

  return {
    messages: responseMessages.map((message) =>
      rewriteMessageToolCallIds(message, toolCallIds)
    ),
    usage: modelUsageEvent({
      attemptId,
      durationMs: finalStep?.performance.responseTimeMs,
      finishReason,
      modelId: firstSafeTelemetryIdentifier(
        response?.modelId ??
          finalStep?.model.modelId ??
          configuredModelId(model),
        finalStep?.model.modelId,
        configuredModelId(model)
      ),
      provider: firstSafeTelemetryIdentifier(
        finalStep?.model.provider,
        configuredProvider(model)
      ),
      usage,
    }),
  };
}

function modelUsageEvent({
  attemptId,
  durationMs,
  finishReason,
  modelId,
  provider,
  usage,
}: {
  readonly attemptId: string;
  readonly durationMs?: number;
  readonly finishReason?: ModelUsage["finishReason"];
  readonly modelId?: string;
  readonly provider?: string;
  readonly usage?: LanguageModelUsage;
}): ModelUsage {
  const { cacheReadTokens, cacheWriteTokens, noCacheTokens } =
    usage?.inputTokenDetails ?? {};
  const { reasoningTokens } = usage?.outputTokenDetails ?? {};
  const { inputTokens, outputTokens, totalTokens } = usage ?? {};
  const normalized = {
    cacheReadTokens: safeTokenCount(cacheReadTokens),
    cacheWriteTokens: safeTokenCount(cacheWriteTokens),
    durationMs: safeDuration(durationMs),
    finishReason: safeFinishReason(finishReason),
    inputTokens: safeTokenCount(inputTokens),
    modelId: safeTelemetryIdentifier(modelId),
    noCacheTokens: safeTokenCount(noCacheTokens),
    outputTokens: safeTokenCount(outputTokens),
    provider: safeTelemetryIdentifier(provider),
    reasoningTokens: safeTokenCount(reasoningTokens),
    totalTokens: safeTokenCount(totalTokens),
  };

  return {
    attemptId,
    ...(normalized.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: normalized.cacheReadTokens }),
    ...(normalized.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: normalized.cacheWriteTokens }),
    ...(normalized.durationMs === undefined
      ? {}
      : { durationMs: normalized.durationMs }),
    ...(normalized.finishReason === undefined
      ? {}
      : { finishReason: normalized.finishReason }),
    ...(normalized.inputTokens === undefined
      ? {}
      : { inputTokens: normalized.inputTokens }),
    ...(normalized.modelId === undefined
      ? {}
      : { modelId: normalized.modelId }),
    ...(normalized.noCacheTokens === undefined
      ? {}
      : { noCacheTokens: normalized.noCacheTokens }),
    ...(normalized.outputTokens === undefined
      ? {}
      : { outputTokens: normalized.outputTokens }),
    ...(normalized.provider === undefined
      ? {}
      : { provider: normalized.provider }),
    ...(normalized.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: normalized.reasoningTokens }),
    ...(normalized.totalTokens === undefined
      ? {}
      : { totalTokens: normalized.totalTokens }),
    type: "model-usage",
  };
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeDuration(value: unknown): number | undefined {
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    return;
  }
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}

function safeFinishReason(
  value: unknown
): ModelUsage["finishReason"] | undefined {
  return typeof value === "string" &&
    FINISH_REASONS.has(value as ModelUsage["finishReason"])
    ? (value as ModelUsage["finishReason"])
    : undefined;
}

function safeTelemetryIdentifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    SAFE_TELEMETRY_IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;
}

function firstSafeTelemetryIdentifier(
  ...values: readonly unknown[]
): string | undefined {
  for (const value of values) {
    const safe = safeTelemetryIdentifier(value);
    if (safe !== undefined) {
      return safe;
    }
  }
  return;
}

function configuredModelId(model: LanguageModel): string | undefined {
  return typeof model === "string" ? model : model.modelId;
}

function configuredProvider(model: LanguageModel): string | undefined {
  return typeof model === "string" ? undefined : model.provider;
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
