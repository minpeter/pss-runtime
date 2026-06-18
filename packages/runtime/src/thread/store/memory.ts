import type {
  CommitResult,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "./types";

export class MemoryThreadStore implements ThreadStore {
  readonly #threads = new Map<string, StoredThread>();
  readonly #versions = new Map<string, number>();

  load(key: string): Promise<StoredThread | null> {
    const stored = this.#threads.get(key);
    return Promise.resolve(stored ? structuredClone(stored) : null);
  }

  delete(key: string): Promise<void> {
    this.#threads.delete(key);
    this.#versions.delete(key);
    return Promise.resolve();
  }

  commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    const current = this.#threads.get(key);
    const currentVersion = current?.version ?? null;

    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const versionNumber = (this.#versions.get(key) ?? 0) + 1;
    const version = String(versionNumber);
    this.#versions.set(key, versionNumber);
    this.#threads.set(key, structuredClone({ state: next.state, version }));
    return Promise.resolve({ ok: true, version });
  }
}

/** @deprecated Use MemoryThreadStore. */
export { MemoryThreadStore as MemorySessionStore };
