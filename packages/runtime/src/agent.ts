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
    this.#llm =
      options.llm ??
      createLlm({
        instructions: options.instructions,
        model: options.model,
        tools: options.tools,
      });
  }

  createSession(): AgentSession {
    return new AgentSession(this.#llm);
  }
}
