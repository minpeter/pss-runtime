import type { LanguageModel, ToolSet } from "ai";
import type { AgentHost } from "./execution/types";
import type { AgentToolChoice, RuntimeLlm } from "./llm";
import type { AgentPlugin } from "./plugins";

interface AgentLanguageModelOptions {
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model: LanguageModel;
  readonly namespace?: string;
  readonly plugins?: readonly AgentPlugin[];
  readonly toolChoice?: AgentToolChoice;
  readonly tools?: ToolSet;
}

interface AgentRuntimeModelOptions {
  readonly host?: AgentHost;
  readonly instructions?: never;
  readonly model: RuntimeLlm;
  readonly namespace?: string;
  readonly plugins?: readonly AgentPlugin[];
  readonly toolChoice?: never;
  readonly tools?: never;
}

export type AgentModelOptions = Pick<
  AgentLanguageModelOptions,
  "instructions" | "model" | "toolChoice"
>;
export type AgentOptions = AgentLanguageModelOptions | AgentRuntimeModelOptions;

export type AgentConstructionOptions = AgentOptions;

export function assertAgentOptions(
  options: unknown
): asserts options is AgentConstructionOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Agent options are required. Provide { model }.");
  }

  const hasModel = "model" in options && options.model != null;

  if (!hasModel) {
    throw new TypeError("Agent: missing options.model.");
  }

  if (
    typeof options.model !== "function" &&
    (typeof options.model !== "object" || options.model === null)
  ) {
    throw new TypeError("Agent: invalid options.model.");
  }
}

export function hasRuntimeModel(
  options: AgentConstructionOptions
): options is AgentRuntimeModelOptions {
  return typeof options.model === "function";
}

export function hasLanguageModel(
  options: AgentConstructionOptions
): options is AgentLanguageModelOptions {
  return typeof options.model !== "function";
}
