import type { ModelMessage } from "ai";
import type { ThreadStore } from "../store/types";
import { ModelMessageHistory } from "./history";
import {
  decodeStoredThreadState,
  encodeThreadSnapshot,
  type ThreadCompactionRecord,
} from "./snapshot";

export interface ThreadPersistenceOptions {
  readonly key: string;
  readonly store: ThreadStore;
}

export interface ThreadCheckpointReference {
  readonly kind: "thread-reference";
  readonly schemaVersion: 1;
  readonly threadKey: string;
  readonly threadVersion: string | null;
}

export interface ThreadCompactionInput {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
  readonly summary: string;
}

export class ThreadCommitConflictError extends Error {
  constructor(key: string) {
    super(`Thread ${JSON.stringify(key)} commit conflict`);
  }
}

export class ThreadState {
  readonly #persistence: ThreadPersistenceOptions;
  #deleteRequested = false;
  #history = new ModelMessageHistory();
  #deleted = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #storeVersion: string | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(persistence: ThreadPersistenceOptions) {
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

    this.#loadPromise ??= this.#loadThreadState();
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

  modelContextSnapshot(): ModelMessage[] {
    return this.#history.modelContextSnapshot();
  }

  compactionSnapshot(): ThreadCompactionRecord[] {
    return this.#history.compactionSnapshot();
  }

  threadCheckpointReference(): ThreadCheckpointReference {
    return {
      kind: "thread-reference",
      schemaVersion: 1,
      threadKey: this.#persistence.key,
      threadVersion: this.#storeVersion ?? null,
    };
  }

  appendUserInput(
    input: Parameters<ModelMessageHistory["appendUserInput"]>[0]
  ) {
    this.#history.appendUserInput(input);
  }

  rollback(snapshot: ModelMessage[]): void {
    this.#history.rollback(snapshot);
  }

  async compact(input: ThreadCompactionInput): Promise<void> {
    if (this.#deleteRequested || this.#deleted) {
      return;
    }

    const previous = {
      compactions: this.#history.compactionSnapshot(),
      history: this.#history.modelSnapshot(),
      storeVersion: this.#storeVersion,
    };
    const record: ThreadCompactionRecord = {
      endSeqExclusive: input.endSeqExclusive,
      schemaVersion: 1,
      startSeq: input.startSeq,
      summary: { content: input.summary, role: "system" },
    };
    this.#history.recordCompaction(record);
    try {
      await this.commit();
    } catch (error) {
      if (!(error instanceof ThreadCommitConflictError)) {
        this.#storeVersion = previous.storeVersion;
        this.#history = new ModelMessageHistory(
          previous.history,
          undefined,
          previous.compactions
        );
      }
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (this.#deleteRequested || this.#deleted) {
      return;
    }

    const snapshot = this.#history.modelSnapshot();
    const compactions = this.#history.compactionSnapshot();
    await this.#enqueueWrite(async () => {
      if (this.#deleteRequested || this.#deleted) {
        return;
      }

      const result = await this.#persistence.store.commit(
        this.#persistence.key,
        { state: encodeThreadSnapshot(snapshot, compactions) },
        { expectedVersion: this.#storeVersion ?? null }
      );

      if (!result.ok) {
        await this.#replaceWithStoredThread();
        throw new ThreadCommitConflictError(this.#persistence.key);
      }

      this.#storeVersion = result.version;
    });
  }

  async delete(): Promise<void> {
    if (this.#deleted) {
      return;
    }

    const previous = {
      compactions: this.#history.compactionSnapshot(),
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
        this.#history = new ModelMessageHistory(
          previous.history,
          undefined,
          previous.compactions
        );
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

  async #loadThreadState(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    await this.#replaceWithStoredThread();
    this.#loaded = true;
  }

  async #replaceWithStoredThread(): Promise<void> {
    const stored = await this.#persistence.store.load(this.#persistence.key);
    this.#storeVersion = stored?.version;
    const state = decodeStoredThreadState(stored);
    this.#history = new ModelMessageHistory(
      state.history,
      undefined,
      state.compactions
    );
  }
}
