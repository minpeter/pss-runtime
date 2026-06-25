import type { LanguageModel, ToolSet } from "ai";
import type { AgentHost } from "../../execution/host/types";
import type { AgentToolChoice } from "../../llm/llm";
import type { AgentInput, UserInput } from "../../thread/input/input";
import type { AgentPlugin } from "../../thread/plugins/pipeline";
import {
  type AgentInstrumentation,
  normalizeAgentInstrumentations,
} from "./instrumentation";

export interface AgentAutoCompactionOptions {
  readonly minMessages: number;
  readonly retainMessages: number;
}

export interface AgentOptions {
  readonly autoCompaction?: AgentAutoCompactionOptions | false;
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly instrumentations?: readonly AgentInstrumentation[];
  readonly model: LanguageModel;
  readonly namespace?: string;
  readonly notificationOverlays?: readonly (AgentInput | UserInput)[];
  readonly plugins?: readonly AgentPlugin[];
  readonly toolChoice?: AgentToolChoice;
  readonly tools?: ToolSet;
}

export type AgentModelOptions = Pick<
  AgentOptions,
  "instructions" | "model" | "toolChoice" | "tools"
>;

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
    readonly instrumentations?: AgentOptions["instrumentations"];
  };
  normalizeAgentAutoCompactionOptions(candidate.autoCompaction);
  normalizeAgentInstrumentations(candidate.instrumentations);
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

  return {
    minMessages: value.minMessages,
    retainMessages: value.retainMessages,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
