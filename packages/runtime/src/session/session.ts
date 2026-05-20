import { runAgentLoop } from "../agent-loop";
import type { AgentMessage, Llm } from "../llm";
import type { AgentEvent, AgentEventListener, UserText } from "./events";
import { AgentModelHistory } from "./history";

export type SessionInput = UserText;

export interface SessionOptions {
  history?: AgentMessage[];
  onHistoryChange?: (history: AgentMessage[]) => void | Promise<void>;
}

interface QueuedInput {
  input: SessionInput;
  reject: (error: unknown) => void;
  resolve: () => void;
}

export class AgentSession {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #llm: Llm;
  readonly #history: AgentModelHistory;
  readonly #inputQueue: QueuedInput[] = [];
  #running = false;
  #activeAbort?: AbortController;
  #killed = false;
  #historyPromiseChain: Promise<void> = Promise.resolve();
  #pendingWrites: Promise<void>[] = [];

  constructor(llm: Llm, options?: SessionOptions) {
    this.#llm = llm;
    const { history, onHistoryChange } = options ?? {};
    this.#history = new AgentModelHistory(
      history,
      onHistoryChange
        ? () => {
            const writePromise = this.#historyPromiseChain
              .then(async () => {
                await onHistoryChange(this.getHistory());
              })
              .catch((error: unknown) => {
                throw new Error(
                  `onHistoryChange failed: ${errorMessage(error)}`
                );
              });

            this.#historyPromiseChain = writePromise.catch(() => {
              // Catch errors to ensure the chain continues for subsequent writes
            });
            this.#pendingWrites.push(writePromise);
          }
        : undefined
    );
  }

  getHistory(): AgentMessage[] {
    return this.#history.modelSnapshot();
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

    this.#drainInputQueue().catch((error: unknown) => {
      this.#emit({ type: "turn-error", message: errorMessage(error) });
    });
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
        const historySnapshot = this.#history.modelSnapshot();
        this.#pendingWrites = [];

        try {
          this.#emit({ type: "turn-start" });
          this.#history.appendUserInput(item.input);

          const result = await runAgentLoop({
            emit: (event) => this.#emit(event),
            history: this.#history,
            llm: this.#llm,
            signal: this.#activeAbort.signal,
          });

          await Promise.all(this.#pendingWrites);

          this.#emit({
            type: result === "aborted" ? "turn-abort" : "turn-end",
          });
          item.resolve();
        } catch (error) {
          this.#pendingWrites = [];
          this.#history.rollback(historySnapshot);
          this.#pendingWrites = [];

          this.#emit({ type: "turn-error", message: errorMessage(error) });
          item.reject(error);
        } finally {
          this.#pendingWrites = [];
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sessionKilledError(): Error {
  return new Error("Session killed");
}
