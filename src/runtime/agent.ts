import type { LanguageModel } from "ai";
import { type AgentTools, tools as defaultTools } from "../tools";
import { createLlm, type Llm } from "./llm";
import { AgentSession } from "./session/session";

export interface AgentOptions {
  instructions?: string;
  llm?: Llm;
  model?: LanguageModel;
  tools?: AgentTools;
}

export class Agent {
  readonly #llm: Llm;

  constructor(options: AgentOptions = {}) {
    this.#llm =
      options.llm ??
      createLlm({
        instructions: options.instructions,
        model: options.model,
        tools: options.tools ?? defaultTools,
      });
  }

  createSession(): AgentSession {
    return new AgentSession(this.#llm);
  }
}
