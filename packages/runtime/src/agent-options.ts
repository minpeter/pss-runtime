import type { LanguageModel, ToolSet } from "ai";
import type { Agent } from "./agent";
import type { AgentHost } from "./execution/types";
import type { AgentToolChoice, RuntimeLlm } from "./llm";
import type { AgentPlugin } from "./plugins";

interface AgentLanguageModelOptions {
  readonly description?: string;
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model: LanguageModel;
  readonly name?: string;
  readonly namespace?: string;
  readonly plugins?: readonly AgentPlugin[];
  readonly subagents?: readonly Agent[];
  readonly toolChoice?: AgentToolChoice;
  readonly tools?: ToolSet;
}

interface AgentRuntimeModelOptions {
  readonly description?: string;
  readonly host?: AgentHost;
  readonly instructions?: never;
  readonly model: RuntimeLlm;
  readonly name?: string;
  readonly namespace?: string;
  readonly plugins?: readonly AgentPlugin[];
  readonly subagents?: never;
  readonly toolChoice?: never;
  readonly tools?: never;
}

export type AgentModelOptions = Pick<
  AgentLanguageModelOptions,
  "instructions" | "model" | "toolChoice"
>;
export type AgentOptions = AgentLanguageModelOptions | AgentRuntimeModelOptions;

export function assertAgentOptions(
  options: unknown
): asserts options is AgentOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Agent options are required. Provide { model }.");
  }

  if ("sessions" in options) {
    throw new TypeError(
      "Agent: unsupported options.sessions. Use host: { sessionStore } and namespace instead."
    );
  }

  if ("runtime" in options) {
    throw new TypeError("Agent: unsupported options.runtime. Use host.");
  }

  if ("llm" in options) {
    throw new TypeError(
      "Agent: unsupported options.llm. Use model for both AI SDK models and custom RuntimeLlm functions."
    );
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
  options: AgentOptions
): options is AgentRuntimeModelOptions {
  return typeof options.model === "function";
}
