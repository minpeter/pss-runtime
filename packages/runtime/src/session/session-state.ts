import type { ModelMessage } from "ai";
import { ModelMessageHistory } from "./history";
import { decodeStoredSessionSnapshot, encodeSessionSnapshot } from "./snapshot";
import type { SessionStore } from "./store/types";

export interface SessionPersistenceOptions {
  readonly key: string;
  readonly store: SessionStore;
}

export class SessionCommitConflictError extends Error {
  constructor(key: string) {
    super(`Session ${JSON.stringify(key)} commit conflict`);
  }
}

export class SessionState {
  readonly #persistence: SessionPersistenceOptions;
  #deleteRequested = false;
  #history = new ModelMessageHistory();
  #deleted = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #storeVersion: string | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(persistence: SessionPersistenceOptions) {
    this.#persistence = persistence;
  }

  get history(): ModelMessageHistory {
    return this.#history;
  }

  async ensureLoaded(): Promise<void> {
    if (this.#deleteRequested || this.#deleted) {
      return;
    }

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

  modelSnapshot(): ModelMessage[] {
    return this.#history.modelSnapshot();
  }

  appendUserInput(
    input: Parameters<ModelMessageHistory["appendUserInput"]>[0]
  ) {
    this.#history.appendUserInput(input);
  }

  rollback(snapshot: ModelMessage[]): void {
    this.#history.rollback(snapshot);
  }

  async commit(): Promise<void> {
    if (this.#deleteRequested || this.#deleted) {
      return;
    }

    const snapshot = this.#history.modelSnapshot();
    await this.#enqueueWrite(async () => {
      if (this.#deleteRequested || this.#deleted) {
        return;
      }

      const result = await this.#persistence.store.commit(
        this.#persistence.key,
        { state: encodeSessionSnapshot(snapshot) },
        { expectedVersion: this.#storeVersion ?? null }
      );

      if (!result.ok) {
        await this.#replaceWithStoredSession();
        throw new SessionCommitConflictError(this.#persistence.key);
      }

      this.#storeVersion = result.version;
    });
  }

  async delete(): Promise<void> {
    if (this.#deleted) {
      return;
    }

    const previous = {
      history: this.#history.modelSnapshot(),
      loaded: this.#loaded,
      storeVersion: this.#storeVersion,
    };
    this.#deleteRequested = true;
    this.#loadPromise = undefined;

    await this.#enqueueWrite(async () => {
      try {
        await this.#persistence.store.delete(this.#persistence.key);
      } catch (error) {
        this.#deleteRequested = false;
        this.#loaded = previous.loaded;
        this.#storeVersion = previous.storeVersion;
        this.#history = new ModelMessageHistory(previous.history);
        throw error;
      }

      this.#deleted = true;
      this.#loadPromise = undefined;
      this.#loaded = true;
      this.#storeVersion = undefined;
      this.#history = new ModelMessageHistory();
    });
  }

  #enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.catch(() => undefined);
    return next;
  }

  async #loadSessionState(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    await this.#replaceWithStoredSession();
    this.#loaded = true;
  }

  async #replaceWithStoredSession(): Promise<void> {
    const stored = await this.#persistence.store.load(this.#persistence.key);
    this.#storeVersion = stored?.version;
    this.#history = new ModelMessageHistory(
      decodeStoredSessionSnapshot(stored)
    );
  }
}
