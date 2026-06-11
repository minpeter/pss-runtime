import type { LanguageModel, ToolSet } from "ai";
import type { AgentHost } from "./execution/types";
import type { AgentToolChoice } from "./llm";
import type { AgentPlugin } from "./plugins";

export interface AgentLanguageModelOptions {
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model: LanguageModel;
  readonly namespace?: string;
  readonly plugins?: readonly AgentPlugin[];
  readonly toolChoice?: AgentToolChoice;
  readonly tools?: ToolSet;
}

export type AgentModelOptions = Pick<
  AgentLanguageModelOptions,
  "instructions" | "model" | "toolChoice" | "tools"
>;
export type AgentOptions = AgentLanguageModelOptions;

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

  if (typeof options.model !== "object" || options.model === null) {
    throw new TypeError("Agent: invalid options.model.");
  }
}
