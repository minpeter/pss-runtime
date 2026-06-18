import type { Agent } from "../../agent/core/agent";
import type { AgentEvent } from "../protocol/events";
import type {
  CommitResult,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "../store/types";

export const collect = async (
  run: Awaited<ReturnType<Agent["send"]>>
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
};

export class SpyStore implements SessionStore {
  readonly commits: Array<{
    key: string;
    next: SessionStoreCommit;
    expectedVersion: string | null;
  }> = [];
  loadCount = 0;
  loadGate?: Promise<void>;
  readonly sessions = new Map<string, StoredSession>();

  async load(key: string): Promise<StoredSession | null> {
    this.loadCount += 1;
    await this.loadGate;
    const stored = this.sessions.get(key);
    return stored ? structuredClone(stored) : null;
  }

  delete(key: string): Promise<void> {
    this.sessions.delete(key);
    return Promise.resolve();
  }

  commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    const current = this.sessions.get(key);
    const currentVersion = current?.version ?? null;
    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const version = String(Number(current?.version ?? 0) + 1);
    const stored = structuredClone({ state: next.state, version });
    this.commits.push({
      key,
      next: structuredClone(next),
      expectedVersion: options.expectedVersion,
    });
    this.sessions.set(key, stored);
    return Promise.resolve({ ok: true, version });
  }
}

export class ConflictOnceStore extends SpyStore {
  conflictNextCommit = true;

  override commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    if (this.conflictNextCommit) {
      this.conflictNextCommit = false;
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    return super.commit(key, next, options);
  }
}

export class ConflictOnCommitStore extends SpyStore {
  commitCount = 0;
  conflictOnCommit = 1;

  override commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitCount += 1;
    if (this.commitCount === this.conflictOnCommit) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    return super.commit(key, next, options);
  }
}
