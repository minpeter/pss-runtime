import { runAgentLoop } from "./agent-loop";
import type { AgentEvent, AgentEventListener } from "./events";

export class Agent {
  readonly #listeners = new Set<AgentEventListener>();

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  run(): Promise<string> {
    return runAgentLoop((event) => this.#emit(event));
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
