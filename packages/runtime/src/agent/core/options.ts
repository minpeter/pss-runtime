import type { LanguageModel, ToolSet } from "ai";
import type { AgentHost } from "../../execution/host/types";
import type { AgentToolChoice } from "../../llm/llm";
import type { AgentPlugin } from "../../thread/plugins/pipeline";

export interface AgentOptions {
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model: LanguageModel;
  readonly namespace?: string;
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
}
