export interface StoredThread {
  readonly state: unknown;
  readonly version: string;
}

export interface ThreadStoreCommit {
  readonly state: unknown;
}

export type CommitResult =
  | { ok: true; version: string }
  | { ok: false; reason: "conflict" };

export type ExpectedThreadVersion = string | null;

export interface ThreadStore {
  commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: ExpectedThreadVersion }
  ): Promise<CommitResult>;
  delete(key: string): Promise<void>;
  load(key: string): Promise<StoredThread | null>;
}

/** @deprecated Use StoredThread. */
export type StoredSession = StoredThread;

/** @deprecated Use ThreadStoreCommit. */
export type SessionStoreCommit = ThreadStoreCommit;

/** @deprecated Use ExpectedThreadVersion. */
export type ExpectedSessionVersion = ExpectedThreadVersion;

/** @deprecated Use ThreadStore. */
export type SessionStore = ThreadStore;
