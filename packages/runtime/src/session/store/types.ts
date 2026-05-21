export interface StoredSession {
  state: unknown;
  version?: string;
}

export type CommitResult =
  | { ok: true; version: string }
  | { ok: false; reason: "conflict" };

export type ExpectedSessionVersion = string | null;

export interface SessionStore {
  commit(
    key: string,
    next: StoredSession,
    options?: { expectedVersion?: ExpectedSessionVersion }
  ): Promise<CommitResult>;
  load(key: string): Promise<StoredSession | null>;
}
