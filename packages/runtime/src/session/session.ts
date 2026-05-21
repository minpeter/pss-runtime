import { runAgentLoop } from "../agent-loop";
import type { AgentMessage, Llm } from "../llm";
import type { UserText } from "./events";
import { AgentModelHistory } from "./history";
import type { AgentRun } from "./run";
import { BufferedAgentRun } from "./run";
import type { SessionStore, StoredSession } from "./store/types";

export type AgentInput = string | readonly string[] | UserText;
export type SessionInput = AgentInput;
export type { AgentRun } from "./run";

interface SessionPersistenceOptions {
  readonly key: string;
  readonly store: SessionStore;
}

interface QueuedInput {
  readonly input: UserText;
  readonly run: BufferedAgentRun;
}

interface EncodedSessionState {
  readonly history: AgentMessage[];
  readonly schemaVersion: 1;
}

export class AgentSession {
  readonly #inputQueue: QueuedInput[] = [];
  readonly #llm: Llm;
  readonly #persistence: SessionPersistenceOptions;
  #activeAbort?: AbortController;
  #history = new AgentModelHistory();
  #killed = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #running = false;
  #storeVersion: string | undefined;

  constructor(llm: Llm, persistence: SessionPersistenceOptions) {
    this.#llm = llm;
    this.#persistence = persistence;
  }

  async send(input: AgentInput): Promise<AgentRun> {
    if (this.#killed) {
      throw sessionKilledError();
    }

    await this.#ensureLoaded();

    if (this.#killed) {
      throw sessionKilledError();
    }

    const acceptedInput = normalizeAgentInput(input);
    const run = new BufferedAgentRun();
    run.emit(acceptedInput);
    this.#inputQueue.push({ input: structuredClone(acceptedInput), run });
    this.#drainInputQueue().catch((error: unknown) => {
      run.emit({ type: "turn-error", message: errorMessage(error) });
      run.close();
    });
    return run;
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
      const item = this.#inputQueue.shift();
      item?.run.emit({
        type: "turn-error",
        message: sessionKilledError().message,
      });
      item?.run.close();
    }
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    this.#loadPromise ??= this.#loadSessionState();
    try {
      await this.#loadPromise;
    } catch (error) {
      this.#loadPromise = undefined;
      throw error;
    }
  }

  async #loadSessionState(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    const stored = await this.#persistence.store.load(this.#persistence.key);
    this.#storeVersion = stored?.version;
    this.#history = new AgentModelHistory(decodeStoredHistory(stored));
    this.#loaded = true;
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;
    try {
      while (!this.#killed && this.#inputQueue.length > 0) {
        const item = this.#inputQueue.shift();
        if (item) {
          await this.#processQueuedInput(item);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #processQueuedInput({ input, run }: QueuedInput): Promise<void> {
    this.#activeAbort = new AbortController();
    const historySnapshot = this.#history.modelSnapshot();

    try {
      run.emit({ type: "turn-start" });
      this.#history.appendUserInput(input);
      await this.#commitHistory();

      const result = await runAgentLoop({
        emit: (event) => run.emit(event),
        history: this.#history,
        llm: this.#llm,
        signal: this.#activeAbort.signal,
      });

      await this.#commitHistory();
      run.emit({ type: result === "aborted" ? "turn-abort" : "turn-end" });
    } catch (error) {
      this.#history.rollback(historySnapshot);
      try {
        await this.#commitHistory();
      } catch (rollbackError) {
        run.emit({
          type: "turn-error",
          message: `${errorMessage(error)}; history rollback persistence failed: ${errorMessage(
            rollbackError
          )}`,
        });
        return;
      }
      run.emit({ type: "turn-error", message: errorMessage(error) });
    } finally {
      run.close();
      this.#activeAbort = undefined;
    }
  }

  async #commitHistory(): Promise<void> {
    const result = await this.#persistence.store.commit(
      this.#persistence.key,
      {
        state: encodeHistory(this.#history.modelSnapshot()),
        version: this.#storeVersion,
      },
      { expectedVersion: this.#storeVersion }
    );

    if (!result.ok) {
      throw new Error(
        `Session ${JSON.stringify(this.#persistence.key)} commit conflict`
      );
    }

    this.#storeVersion = result.version;
  }
}

export function normalizeAgentInput(input: AgentInput): UserText {
  if (typeof input === "string") {
    return {
      type: "user-text",
      text: input,
    };
  }

  if (isStringArrayInput(input)) {
    return {
      type: "user-text",
      text: structuredClone(input) as readonly string[],
    };
  }

  return structuredClone(input);
}

function isStringArrayInput(input: AgentInput): input is readonly string[] {
  return Array.isArray(input);
}

function encodeHistory(history: AgentMessage[]): EncodedSessionState {
  return { schemaVersion: 1, history };
}

function decodeStoredHistory(stored: StoredSession | null): AgentMessage[] {
  if (!stored) {
    return [];
  }

  const state = stored.state;
  if (
    state !== null &&
    typeof state === "object" &&
    "schemaVersion" in state &&
    state.schemaVersion === 1 &&
    "history" in state &&
    Array.isArray(state.history)
  ) {
    return structuredClone(state.history) as AgentMessage[];
  }

  throw new Error("Unsupported stored session state");
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
