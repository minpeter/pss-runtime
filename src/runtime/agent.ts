import { runAgentLoop } from "./agent-loop";
import type { AgentEvent, AgentEventListener } from "./events";
import { mockLlm, type Llm } from "./mock-llm";

type AgentOptions = {
  llm?: Llm;
};

export class Agent {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #llm: Llm;

  constructor(options: AgentOptions = {}) {
    this.#llm = options.llm ?? mockLlm;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  run(): Promise<void> {
    return runAgentLoop({
      emit: (event) => this.#emit(event),
      llm: this.#llm,
    });
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
