export interface StoredSession {
  state: unknown;
  version?: string;
}

export type CommitResult =
  | { ok: true; version: string }
  | { ok: false; reason: "conflict" };

export interface SessionStore {
  commit(
    key: string,
    next: StoredSession,
    options?: { expectedVersion?: string }
  ): Promise<CommitResult>;
  load(key: string): Promise<StoredSession | null>;
}
