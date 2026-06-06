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
  #history = new ModelMessageHistory();
  #deleted = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #storeVersion: string | undefined;

  constructor(persistence: SessionPersistenceOptions) {
    this.#persistence = persistence;
  }

  get history(): ModelMessageHistory {
    return this.#history;
  }

  async ensureLoaded(): Promise<void> {
    if (this.#deleted) {
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
    if (this.#deleted) {
      return;
    }

    const result = await this.#persistence.store.commit(
      this.#persistence.key,
      {
        state: encodeSessionSnapshot(this.#history.modelSnapshot()),
      },
      { expectedVersion: this.#storeVersion ?? null }
    );

    if (this.#deleted) {
      if (result.ok) {
        await this.#persistence.store.delete(this.#persistence.key);
      }
      return;
    }

    if (!result.ok) {
      await this.#replaceWithStoredSession();
      throw new SessionCommitConflictError(this.#persistence.key);
    }

    this.#storeVersion = result.version;
  }

  async delete(): Promise<void> {
    await this.#persistence.store.delete(this.#persistence.key);
    this.#deleted = true;
    this.#loadPromise = undefined;
    this.#loaded = true;
    this.#storeVersion = undefined;
    this.#history = new ModelMessageHistory();
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
