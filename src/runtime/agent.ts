import { mockLlm, type Llm } from "./mock-llm";
import { AgentSession } from "./session";

type AgentOptions = {
  llm?: Llm;
};

export class Agent {
  readonly #llm: Llm;

  constructor(options: AgentOptions = {}) {
    this.#llm = options.llm ?? mockLlm;
  }

  createSession(): AgentSession {
    return new AgentSession(this.#llm);
  }
}
