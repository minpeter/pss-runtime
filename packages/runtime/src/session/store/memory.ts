import type {
  CommitResult,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "./types";

export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #versions = new Map<string, number>();

  load(key: string): Promise<StoredSession | null> {
    const stored = this.#sessions.get(key);
    return Promise.resolve(stored ? structuredClone(stored) : null);
  }

  commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    const current = this.#sessions.get(key);
    const currentVersion = current?.version ?? null;

    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const versionNumber = (this.#versions.get(key) ?? 0) + 1;
    const version = String(versionNumber);
    this.#versions.set(key, versionNumber);
    this.#sessions.set(key, structuredClone({ state: next.state, version }));
    return Promise.resolve({ ok: true, version });
  }
}
