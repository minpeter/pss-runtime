import type { LanguageModel, ToolSet } from "ai";
import type { AgentHost } from "./execution/types";
import type { AgentToolChoice, RuntimeLlm } from "./llm";
import type { AgentPlugin } from "./plugins";
import type { SubagentDefinition } from "./subagent-definition";

interface AgentLanguageModelOptions {
  readonly description?: string;
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model: LanguageModel;
  readonly namespace?: string;
  readonly plugins?: readonly AgentPlugin[];
  readonly subagents?: readonly SubagentDefinition[];
  readonly toolChoice?: AgentToolChoice;
  readonly tools?: ToolSet;
}

interface AgentRuntimeModelOptions {
  readonly description?: string;
  readonly host?: AgentHost;
  readonly instructions?: never;
  readonly model: RuntimeLlm;
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

export type AgentConstructionOptions = AgentOptions;

export function assertAgentOptions(
  options: unknown
): asserts options is AgentConstructionOptions {
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

  if ("name" in options && options.name !== undefined) {
    throw new TypeError(
      "Agent: unsupported options.name. Use namespace for session scoping and SubagentDefinition.name for delegation."
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
  options: AgentConstructionOptions
): options is AgentRuntimeModelOptions {
  return typeof options.model === "function";
}

export function hasLanguageModel(
  options: AgentConstructionOptions
): options is AgentLanguageModelOptions {
  return typeof options.model !== "function";
}
