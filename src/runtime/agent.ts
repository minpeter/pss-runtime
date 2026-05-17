import type { LanguageModel } from "ai";
import { createLlm, type Llm } from "./llm";
import { mockLlm } from "./mock-llm";
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
      (options.model
        ? createLlm({
            instructions: options.instructions,
            model: options.model,
          })
        : mockLlm);
  }

  createSession(): AgentSession {
    return new AgentSession(this.#llm);
  }
}
