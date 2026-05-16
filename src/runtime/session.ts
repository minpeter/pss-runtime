import { runAgentLoop } from "./agent-loop";
import type { AgentEvent, AgentEventListener } from "./events";
import type { Llm } from "./mock-llm";

export type SessionInput = { type: "user-message"; text: string };

type QueuedInput = {
  input: SessionInput;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class AgentSession {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #llm: Llm;
  readonly #inputQueue: QueuedInput[] = [];
  #running = false;
  #activeAbort?: AbortController;

  constructor(llm: Llm) {
    this.#llm = llm;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  submit(input: SessionInput): Promise<void> {
    this.#emit(input);

    const queued = new Promise<void>((resolve, reject) => {
      this.#inputQueue.push({ input, resolve, reject });
    });

    void this.#drainInputQueue();
    return queued;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      while (this.#inputQueue.length > 0) {
        const item = this.#inputQueue.shift();

        if (!item) {
          continue;
        }

        this.#activeAbort = new AbortController();

        try {
          await runAgentLoop({
            emit: (event) => this.#emit(event),
            llm: this.#llm,
            signal: this.#activeAbort.signal,
          });
          item.resolve();
        } catch (error) {
          item.reject(error);
        } finally {
          this.#activeAbort = undefined;
        }
      }
    } finally {
      this.#running = false;
    }
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
