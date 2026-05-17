import { runAgentLoop } from "../agent-loop";
import type { Llm } from "../llm";
import {
  toUserModelMessage,
  type AgentEvent,
  type AgentEventListener,
  type ModelHistoryItem,
  type UserText,
} from "./events";
import type { ModelMessage } from "ai";

export type SessionInput = UserText;

type QueuedInput = {
  input: SessionInput;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class AgentSession {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #llm: Llm;
  readonly #history: ModelHistoryItem[] = [];
  readonly #modelHistory: ModelMessage[] = [];
  readonly #inputQueue: QueuedInput[] = [];
  #running = false;
  #activeAbort?: AbortController;
  #killed = false;

  constructor(llm: Llm) {
    this.#llm = llm;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  submit(input: SessionInput): Promise<void> {
    if (this.#killed) {
      return Promise.reject(sessionKilledError());
    }

    const acceptedInput = structuredClone(input);
    this.#emit(acceptedInput);

    if (this.#killed) {
      return Promise.reject(sessionKilledError());
    }

    const queued = new Promise<void>((resolve, reject) => {
      this.#inputQueue.push({
        input: structuredClone(acceptedInput),
        resolve,
        reject,
      });
    });

    void this.#drainInputQueue();
    return queued;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  kill(): void {
    if (this.#killed) {
      return;
    }

    this.#killed = true;
    this.#activeAbort?.abort();

    while (this.#inputQueue.length > 0) {
      this.#inputQueue.shift()?.reject(sessionKilledError());
    }
  }

  history(): ModelHistoryItem[] {
    return structuredClone(this.#history);
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      while (!this.#killed && this.#inputQueue.length > 0) {
        const item = this.#inputQueue.shift();

        if (!item) {
          continue;
        }

        this.#activeAbort = new AbortController();

        try {
          this.#emit({ type: "turn-start" });
          this.#history.push(structuredClone(item.input));
          this.#modelHistory.push(toUserModelMessage(item.input));

          const result = await runAgentLoop({
            emit: (event) => {
              if (isModelHistoryItem(event)) {
                this.#history.push(structuredClone(event));
              }

              this.#emit(event);
            },
            history: this.#modelHistory,
            llm: this.#llm,
            signal: this.#activeAbort.signal,
          });
          this.#emit({
            type: result === "aborted" ? "turn-abort" : "turn-end",
          });
          item.resolve();
        } catch (error) {
          this.#emit({ type: "turn-error", message: errorMessage(error) });
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

function isModelHistoryItem(event: AgentEvent): event is ModelHistoryItem {
  return (
    event.type === "user-text" ||
    event.type === "assistant-text" ||
    event.type === "tool-call"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sessionKilledError(): Error {
  return new Error("Session killed");
}
