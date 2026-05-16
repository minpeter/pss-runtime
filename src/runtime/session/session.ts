import { runAgentLoop } from "../agent-loop";
import type { Llm } from "../mock-llm";
import type { AgentEvent, AgentEventListener } from "./events";
import {
  SessionHistory,
  type PendingUserInput,
  type SessionHistoryView,
  type SessionSnapshot,
} from "./history";
import type { SessionHistoryStore } from "./store";

export type SessionInput = { type: "user-text"; text: string };

export type AgentSessionOptions = {
  id: string;
  llm: Llm;
  snapshot?: SessionSnapshot;
  historyStore?: SessionHistoryStore;
};

type QueuedInput = {
  input: SessionInput;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class AgentSession {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #llm: Llm;
  readonly #historyStore?: SessionHistoryStore;
  readonly #history: SessionHistory;
  readonly id: string;
  readonly #inputQueue: QueuedInput[] = [];
  #saveQueue: Promise<void> = Promise.resolve();
  #running = false;
  #activeAbort?: AbortController;

  constructor({ id, llm, snapshot, historyStore }: AgentSessionOptions) {
    this.id = id;
    this.#llm = llm;
    this.#historyStore = historyStore;
    this.#history = new SessionHistory(id, snapshot);
    this.#restorePendingInputs();
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  submit(input: SessionInput): Promise<void> {
    const acceptedInput = clone(input);
    const queuedInput = clone(acceptedInput);
    this.#emit(acceptedInput);

    if (this.#historyStore) {
      void this.save().catch(() => {});
    }

    const queued = new Promise<void>((resolve, reject) => {
      this.#inputQueue.push({ input: queuedInput, resolve, reject });
    });

    void this.#drainInputQueue();
    return queued;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  snapshot(): SessionSnapshot {
    return this.#history.snapshot();
  }

  viewAt(sequence: number): SessionHistoryView {
    return this.#history.viewAt(sequence);
  }

  restore(snapshot: SessionSnapshot): void {
    if (this.#running) {
      throw new Error("Cannot restore history while the session is running");
    }

    this.#history.restore(snapshot);
    this.#restorePendingInputs();
  }

  async save(): Promise<void> {
    if (!this.#historyStore) {
      return;
    }

    const snapshot = this.snapshot();
    const save = this.#saveQueue.then(() => this.#historyStore?.save(snapshot));
    this.#saveQueue = save.catch(() => {});
    await save;
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
        let turnClosed = false;

        try {
          this.#emit({ type: "turn-start" });

          const result = await runAgentLoop({
            emit: (event) => this.#emit(event),
            llm: this.#llm,
            modelHistory: () => this.#history.modelHistory(),
            signal: this.#activeAbort.signal,
          });

          this.#emit({
            type: result === "aborted" ? "turn-abort" : "turn-end",
          });
          turnClosed = true;
          await this.save();
          item.resolve();
        } catch (error) {
          if (!turnClosed) {
            this.#emit({ type: "turn-error", message: errorMessage(error) });
            await this.#trySave();
          }
          item.reject(error);
        } finally {
          this.#activeAbort = undefined;
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #trySave(): Promise<void> {
    try {
      await this.save();
    } catch {
      // Preserve the original turn failure for submit() callers.
    }
  }

  #restorePendingInputs(): void {
    this.#inputQueue.length = 0;

    for (const input of this.#history.pendingInputs()) {
      this.#inputQueue.push(createRestoredInput(input));
    }
  }

  #emit(event: AgentEvent): { sequence: number } {
    const record = this.#history.appendEvent(event);

    for (const listener of this.#listeners) {
      listener(clone(event));
    }

    return record;
  }
}

function createRestoredInput(input: PendingUserInput): QueuedInput {
  return {
    input: clone(input),
    reject: () => {},
    resolve: () => {},
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
