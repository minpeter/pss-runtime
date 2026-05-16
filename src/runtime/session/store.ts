import type { SessionSnapshot } from "./history";

export interface SessionHistoryStore {
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  save(snapshot: SessionSnapshot): Promise<void>;
}

export class InMemorySessionHistoryStore implements SessionHistoryStore {
  readonly #snapshots = new Map<string, SessionSnapshot>();

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    const snapshot = this.#snapshots.get(sessionId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.#snapshots.set(snapshot.sessionId, structuredClone(snapshot));
  }
}
