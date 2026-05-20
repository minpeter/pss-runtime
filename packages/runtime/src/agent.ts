import type { LanguageModel } from "ai";
import { type AgentTools, createLlm, type Llm } from "./llm";
import { AgentSession } from "./session/session";

interface AgentModelOptions {
  instructions?: string;
  llm?: never;
  model: LanguageModel;
  tools?: AgentTools;
}

interface AgentLlmOptions {
  instructions?: never;
  llm: Llm;
  model?: never;
  tools?: never;
}

export type AgentOptions = AgentModelOptions | AgentLlmOptions;

export class Agent {
  readonly #llm: Llm;

  constructor(options: AgentOptions) {
    assertAgentOptions(options);

    this.#llm = hasCustomLlm(options)
      ? options.llm
      : createLlm({
          instructions: options.instructions,
          model: options.model,
          tools: options.tools,
        });
  }

  createSession(): AgentSession {
    return new AgentSession(this.#llm);
  }
}

function assertAgentOptions(options: unknown): asserts options is AgentOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      "Agent options are required. Provide either { model } or { llm }."
    );
  }

  const hasLlm = hasCustomLlm(options);
  const hasModel =
    "model" in options && options.model !== undefined && options.model !== null;

  if (hasLlm && hasModel) {
    throw new TypeError(
      "Agent constructor: provide either options.llm or options.model, not both."
    );
  }

  if ("llm" in options && options.llm !== undefined && !hasLlm) {
    throw new TypeError("Agent constructor: invalid options.llm.");
  }

  if (!(hasLlm || hasModel)) {
    throw new TypeError("Agent constructor: missing options.model.");
  }
}

function hasCustomLlm(options: object): options is AgentLlmOptions {
  return "llm" in options && typeof options.llm === "function";
}
