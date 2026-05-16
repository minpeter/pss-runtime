import { runAgentLoop } from "../agent-loop";
import type { Llm } from "../mock-llm";
import type { AgentEvent, AgentEventListener } from "./events";
import {
  SessionHistory,
  toModelHistoryItem,
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
  readonly id: string;
  readonly history: SessionHistory;
  readonly #inputQueue: QueuedInput[] = [];
  #running = false;
  #activeAbort?: AbortController;

  constructor({ id, llm, snapshot, historyStore }: AgentSessionOptions) {
    this.id = id;
    this.#llm = llm;
    this.#historyStore = historyStore;
    this.history = new SessionHistory(id, snapshot);
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  submit(input: SessionInput): Promise<void> {
    this.#emit(input);

    if (this.#historyStore) {
      void this.save().catch(() => {});
    }

    const queued = new Promise<void>((resolve, reject) => {
      this.#inputQueue.push({ input, resolve, reject });
    });

    void this.#drainInputQueue();
    return queued;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  snapshot(): SessionSnapshot {
    return this.history.snapshot();
  }

  restore(snapshot: SessionSnapshot): void {
    if (this.#running) {
      throw new Error("Cannot restore history while the session is running");
    }

    this.history.restore(snapshot);
  }

  async save(): Promise<void> {
    await this.#historyStore?.save(this.snapshot());
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
          const turnStart = this.#emit({ type: "turn-start" });
          this.history.appendModelItem(turnStart.sequence, item.input);

          const result = await runAgentLoop({
            emit: (event) => this.#emitLoopEvent(event),
            llm: this.#llm,
            modelHistory: () => this.history.modelHistory(),
            signal: this.#activeAbort.signal,
          });

          await this.save();

          this.#emit({
            type: result === "aborted" ? "turn-abort" : "turn-end",
          });
          turnClosed = true;
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

  #emitLoopEvent(event: AgentEvent): void {
    const record = this.#emit(event);
    const modelHistoryItem = toModelHistoryItem(event);

    if (modelHistoryItem) {
      this.history.appendModelItem(record.sequence, modelHistoryItem);
    }
  }

  async #trySave(): Promise<void> {
    try {
      await this.save();
    } catch {
      // Preserve the original turn failure for submit() callers.
    }
  }

  #emit(event: AgentEvent): { sequence: number } {
    const record = this.history.appendEvent(event);

    for (const listener of this.#listeners) {
      listener(event);
    }

    return record;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
