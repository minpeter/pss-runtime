import type { LanguageModel, ToolSet } from "ai";
import type { AgentHost } from "../../execution/host/types";
import type { AgentToolChoice, ModelContextGateOptions } from "../../llm/llm";
import { assertNoUnsupportedToolApproval } from "../../llm/tool-approval";
import type { HostAttachmentStore } from "../../thread/input/attachments";
import type { AgentInput, UserInput } from "../../thread/input/input";
import type { AgentPlugin } from "../../thread/plugins/pipeline";

export interface AgentAutoCompactionOptions {
  readonly background?: boolean;
  readonly contextGate?: false | AgentContextGateOptions;
  readonly minMessages: number;
  readonly retainMessages: number;
}

export type AgentContextGateOptions = ModelContextGateOptions;

export interface AgentOptions {
  readonly attachmentStore?: HostAttachmentStore;
  readonly autoCompaction?: AgentAutoCompactionOptions | false;
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model: LanguageModel;
  readonly namespace?: string;
  readonly notificationOverlays?: readonly (AgentInput | UserInput)[];
  readonly plugins?: readonly AgentPlugin[];
  readonly toolChoice?: AgentToolChoice;
  readonly tools?: ToolSet;
}

export type AgentModelOptions = Pick<
  AgentOptions,
  "attachmentStore" | "instructions" | "model" | "toolChoice" | "tools"
> & {
  readonly contextGate?: false | AgentContextGateOptions;
};

export function assertAgentOptions(
  options: unknown
): asserts options is AgentOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Agent options are required. Provide { model }.");
  }

  const hasModel = "model" in options && options.model != null;

  if (!hasModel) {
    throw new TypeError("Agent: missing options.model.");
  }

  if (typeof options.model !== "object" || options.model === null) {
    throw new TypeError("Agent: invalid options.model.");
  }

  const candidate = options as {
    readonly autoCompaction?: AgentOptions["autoCompaction"];
    readonly tools?: AgentOptions["tools"];
  };
  assertNoUnsupportedToolApproval(candidate.tools);
  normalizeAgentAutoCompactionOptions(candidate.autoCompaction);
}

export function normalizeAgentAutoCompactionOptions(
  value: AgentOptions["autoCompaction"]
): AgentAutoCompactionOptions | undefined {
  if (value === undefined || value === false) {
    return;
  }

  if (value === null || typeof value !== "object") {
    throw new TypeError("Agent: invalid options.autoCompaction.");
  }

  if (!isPositiveInteger(value.minMessages)) {
    throw new TypeError(
      "Agent: options.autoCompaction.minMessages must be a positive integer."
    );
  }

  if (!isPositiveInteger(value.retainMessages)) {
    throw new TypeError(
      "Agent: options.autoCompaction.retainMessages must be a positive integer."
    );
  }

  if (value.retainMessages >= value.minMessages) {
    throw new TypeError(
      "Agent: options.autoCompaction.retainMessages must be smaller than minMessages."
    );
  }

  if (value.background !== undefined && typeof value.background !== "boolean") {
    throw new TypeError(
      "Agent: options.autoCompaction.background must be a boolean."
    );
  }

  const contextGate = normalizeContextGateOptions(value.contextGate);

  return {
    ...(value.background === undefined ? {} : { background: value.background }),
    ...(contextGate === undefined ? {} : { contextGate }),
    minMessages: value.minMessages,
    retainMessages: value.retainMessages,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeContextGateOptions(
  value: AgentAutoCompactionOptions["contextGate"]
): AgentAutoCompactionOptions["contextGate"] | undefined {
  if (value === undefined) {
    return;
  }

  if (value === false) {
    return false;
  }

  if (!isObjectRecord(value)) {
    throw new TypeError(
      "Agent: options.autoCompaction.contextGate must be an object or false."
    );
  }

  const maxInputTokens = value.maxInputTokens;
  const bufferTokens = value.bufferTokens;
  const estimateTokens = value.estimateTokens;
  const onOverflow = value.onOverflow;
  if (!isPositiveInteger(maxInputTokens)) {
    throw new TypeError(
      "Agent: options.autoCompaction.contextGate.maxInputTokens must be a positive integer."
    );
  }

  if (bufferTokens !== undefined && !isNonNegativeInteger(bufferTokens)) {
    throw new TypeError(
      "Agent: options.autoCompaction.contextGate.bufferTokens must be a non-negative integer."
    );
  }

  if (estimateTokens !== undefined && !isTokenEstimator(estimateTokens)) {
    throw new TypeError(
      "Agent: options.autoCompaction.contextGate.estimateTokens must be a function."
    );
  }

  if (
    onOverflow !== undefined &&
    onOverflow !== "compact" &&
    onOverflow !== "error"
  ) {
    throw new TypeError(
      "Agent: options.autoCompaction.contextGate.onOverflow must be 'compact' or 'error'."
    );
  }

  return {
    ...(bufferTokens === undefined ? {} : { bufferTokens }),
    ...(estimateTokens === undefined ? {} : { estimateTokens }),
    maxInputTokens,
    ...(onOverflow === undefined ? {} : { onOverflow }),
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTokenEstimator(
  value: unknown
): value is NonNullable<ModelContextGateOptions["estimateTokens"]> {
  return typeof value === "function";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
