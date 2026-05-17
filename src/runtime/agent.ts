import type { LanguageModel } from "ai";
import { createLlm, type Llm } from "./llm";
import { AgentSession } from "./session";

type AgentOptions = {
  llm?: Llm;
  model?: LanguageModel;
  instructions?: string;
};

export class Agent {
  readonly #llm: Llm;

  constructor(options: AgentOptions = {}) {
    this.#llm =
      options.llm ??
      createLlm({
        instructions: options.instructions,
        model: options.model,
      });
  }

  createSession(): AgentSession {
    return new AgentSession(this.#llm);
  }
}
