import type { LanguageModel } from "ai";
import { type AgentTools, createLlm, type Llm } from "./llm";
import { AgentSession, type SessionOptions } from "./session/session";

interface AgentModelOptions {
  instructions?: string;
  llm?: never;
  model: LanguageModel;
  providerOptions?: Parameters<typeof createLlm>[0]["providerOptions"];
  tools?: AgentTools;
}

interface AgentLlmOptions {
  instructions?: never;
  llm: Llm;
  model?: never;
  providerOptions?: never;
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
          providerOptions: options.providerOptions,
          tools: options.tools,
        });
  }

  createSession(options?: SessionOptions): AgentSession {
    return new AgentSession(this.#llm, options);
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
