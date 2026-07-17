import type { LanguageModel, ToolSet } from "ai";
import type { AgentHost } from "../../execution/host/types";
import type { AgentToolChoice, ModelContextGateOptions } from "../../llm/llm";
import type { PrepareModelStep } from "../../llm/model-step-preparation";
import { assertNoUnsupportedToolApproval } from "../../llm/tool-approval";
import type { PluginDefinition } from "../../plugins/api";
import type { RuntimeDiagnosticsSink } from "../../plugins/diagnostics";
import type { HostAttachmentStore } from "../../thread/input/attachments";
import type { AgentInput, UserInput } from "../../thread/input/input";

export interface AgentAutoCompactionOptions {
  readonly background?: boolean;
  readonly contextGate?: false | AgentContextGateOptions;
  readonly minMessages: number;
  readonly retainMessages: number;
}

export type AgentContextGateOptions = ModelContextGateOptions;

export interface AgentOptions {
  readonly alwaysActiveTools?: readonly string[];
  readonly attachmentStore?: HostAttachmentStore;
  readonly autoCompaction?: AgentAutoCompactionOptions | false;
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model: LanguageModel;
  readonly namespace?: string;
  readonly notificationOverlays?: readonly (AgentInput | UserInput)[];
  readonly pluginFactoryTimeoutMs?: number;
  readonly pluginHookTimeoutMs?: number;
  readonly plugins?: readonly PluginDefinition[];
  readonly prepareModelStep?: PrepareModelStep;
  readonly toolChoice?: AgentToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export type CreateAgentOptions = AgentOptions;

export interface NormalizedPluginTimeoutOptions {
  readonly factoryTimeoutMs: number;
  readonly hookTimeoutMs: number;
}

export function normalizePluginTimeoutOptions(
  options: Pick<AgentOptions, "pluginFactoryTimeoutMs" | "pluginHookTimeoutMs">
): NormalizedPluginTimeoutOptions {
  const factoryTimeoutMs = options.pluginFactoryTimeoutMs ?? 10_000;
  const hookTimeoutMs = options.pluginHookTimeoutMs ?? 10_000;
  for (const [name, value] of [
    ["pluginFactoryTimeoutMs", factoryTimeoutMs],
    ["pluginHookTimeoutMs", hookTimeoutMs],
  ] as const) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new TypeError(`Agent: options.${name} must be non-negative.`);
    }
  }
  return { factoryTimeoutMs, hookTimeoutMs };
}

export type AgentModelOptions = Pick<
  AgentOptions,
  | "alwaysActiveTools"
  | "attachmentStore"
  | "instructions"
  | "model"
  | "prepareModelStep"
  | "toolChoice"
  | "toolOrder"
  | "tools"
> & {
  readonly contextGate?: false | AgentContextGateOptions;
  readonly diagnostics?: RuntimeDiagnosticsSink;
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
    readonly alwaysActiveTools?: AgentOptions["alwaysActiveTools"];
    readonly autoCompaction?: AgentOptions["autoCompaction"];
    readonly prepareModelStep?: AgentOptions["prepareModelStep"];
    readonly toolOrder?: AgentOptions["toolOrder"];
    readonly tools?: AgentOptions["tools"];
  };
  assertNoUnsupportedToolApproval(candidate.tools);
  assertToolNameList(candidate.alwaysActiveTools, "alwaysActiveTools");
  assertToolNameList(candidate.toolOrder, "toolOrder");
  if (
    candidate.prepareModelStep !== undefined &&
    typeof candidate.prepareModelStep !== "function"
  ) {
    throw new TypeError("Agent: options.prepareModelStep must be a function.");
  }
  normalizeAgentAutoCompactionOptions(candidate.autoCompaction);
}

function assertToolNameList(
  value: readonly string[] | undefined,
  field: "alwaysActiveTools" | "toolOrder"
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`Agent: options.${field} must be an array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
    )
  ) {
    throw new TypeError(`Agent: options.${field} has an invalid length.`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(
        `Agent: options.${field} must be a dense array of data-property tool names.`
      );
    }
    const name = descriptor.value;
    if (typeof name !== "string") {
      throw new TypeError(`Agent: options.${field} must contain only strings.`);
    }
    if (seen.has(name)) {
      throw new TypeError(
        `Agent: options.${field} contains duplicate tool ${JSON.stringify(name)}.`
      );
    }
    seen.add(name);
  }
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
