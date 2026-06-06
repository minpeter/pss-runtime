export interface StoredSession {
  readonly state: unknown;
  readonly version: string;
}

export interface SessionStoreCommit {
  readonly state: unknown;
}

export type CommitResult =
  | { ok: true; version: string }
  | { ok: false; reason: "conflict" };

export type ExpectedSessionVersion = string | null;

export interface SessionStore {
  commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult>;
  load(key: string): Promise<StoredSession | null>;
}
