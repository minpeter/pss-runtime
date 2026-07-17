import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { generateText } from "ai";
import type { RuntimeDiagnosticsSink } from "../plugins/diagnostics";
import {
  type HostAttachmentStore,
  hydrateRuntimeAttachments,
} from "../thread/input/attachments";
import {
  ModelToolSelectionError,
  type PreparedModelToolChoice,
  type PrepareModelStep,
  resolveModelStepOptions,
} from "./model-step-preparation";
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
export type AgentToolChoice = PreparedModelToolChoice;
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
  alwaysActiveTools?: readonly string[];
  attachmentStore?: HostAttachmentStore;
  contextGate?: false | ModelContextGateOptions;
  diagnostics?: RuntimeDiagnosticsSink;
  instructions?: string;
  model: LanguageModel;
  prepareModelStep?: PrepareModelStep;
  toolChoice?: AgentToolChoice;
  toolOrder?: readonly string[];
  tools?: ToolSet;
}

export interface ModelStepOptions extends ModelGenerationOptions {
  history: readonly ModelMessage[];
  runtimeStepIndex?: number;
  signal: AbortSignal;
  threadKey?: string;
  toolExecution?: RuntimeToolExecutionContext;
}

export async function generateModelStep({
  alwaysActiveTools,
  attachmentStore,
  contextGate,
  diagnostics,
  history,
  model,
  instructions,
  prepareModelStep,
  runtimeStepIndex = 0,
  signal,
  threadKey,
  toolChoice,
  toolOrder,
  toolExecution,
  tools,
}: ModelStepOptions): Promise<ModelStepOutput> {
  if (prepareModelStep && threadKey === undefined) {
    throw new ModelToolSelectionError(
      "prepareModelStep requires a runtime threadKey."
    );
  }
  const attemptId = crypto.randomUUID();
  const historySnapshot = snapshotModelHistory(history);
  const toolCallIds = new Map<string, string>();
  const prepared = await resolveModelStepOptions({
    alwaysActiveTools,
    attemptId,
    diagnostics,
    history: historySnapshot,
    model,
    prepareModelStep,
    runtimeStepIndex,
    signal,
    threadKey,
    toolChoice,
    toolOrder,
    tools,
  });
  const prompt = promptForModel({ history: historySnapshot, instructions });
  const messages = await hydrateRuntimeAttachments(
    prompt.messages,
    attachmentStore
  );
  enforceContextGate({
    contextGate,
    instructions: prompt.instructions,
    messages,
  });
  assertNoUnsupportedToolApproval(prepared.tools);
  const { responseMessages } = await generateText({
    activeTools: prepared.activeTools,
    abortSignal: signal,
    instructions: prompt.instructions,
    messages,
    model: prepared.model,
    toolChoice: prepared.toolChoice,
    toolOrder: prepared.toolOrder,
    tools: normalizeToolCallIds(prepared.tools, toolCallIds, toolExecution),
  });

  return responseMessages.map((message) =>
    rewriteMessageToolCallIds(message, toolCallIds)
  );
}

function snapshotModelHistory(
  history: readonly ModelMessage[]
): readonly ModelMessage[] {
  if (!Array.isArray(history)) {
    throw new TypeError("history must be an array of model messages.");
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(history, "length");
  } catch {
    throw new TypeError("history has an invalid length descriptor.");
  }
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      typeof lengthDescriptor.value === "number" &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
    )
  ) {
    throw new TypeError("history has an invalid length.");
  }
  const snapshot: ModelMessage[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(history, String(index));
    } catch {
      throw new TypeError("history contains an invalid message descriptor.");
    }
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(
        "history must be a dense array of data-property model messages."
      );
    }
    snapshot.push(descriptor.value as ModelMessage);
  }
  return Object.freeze(snapshot);
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
