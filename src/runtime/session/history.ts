import type { AgentEvent } from "./events";

export type SessionEventRecord = {
  sequence: number;
  event: AgentEvent;
};

export type ModelHistoryItem =
  | { type: "user-message"; text: string }
  | { type: "assistant-text"; text: string }
  | { type: "tool-call"; toolName: string }
  | { type: "tool-result"; toolName: string; output: unknown }
  | { type: "reasoning"; text: string };

export type ModelHistoryRecord = {
  sequence: number;
  item: ModelHistoryItem;
};

export type SessionSnapshot = {
  version: "pss-session-v1";
  sessionId: string;
  nextSequence: number;
  events: SessionEventRecord[];
  modelHistory: ModelHistoryRecord[];
};

export type SessionHistoryView = SessionSnapshot;

export class SessionHistory {
  readonly #sessionId: string;
  #nextSequence = 1;
  #events: SessionEventRecord[] = [];
  #modelHistory: ModelHistoryRecord[] = [];

  constructor(sessionId: string, snapshot?: SessionSnapshot) {
    this.#sessionId = sessionId;

    if (snapshot) {
      this.restore(snapshot);
    }
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  appendEvent(event: AgentEvent): SessionEventRecord {
    const record = { sequence: this.#nextSequence, event: clone(event) };
    this.#nextSequence += 1;
    this.#events.push(record);
    return clone(record);
  }

  appendModelItem(sequence: number, item: ModelHistoryItem): ModelHistoryRecord {
    const record = { sequence, item: clone(item) };
    this.#modelHistory.push(record);
    return clone(record);
  }

  modelHistory(): ModelHistoryItem[] {
    return this.#modelHistory.map((record) => clone(record.item));
  }

  snapshot(): SessionSnapshot {
    return this.#snapshotFrom({
      events: this.#events,
      modelHistory: this.#modelHistory,
      nextSequence: this.#nextSequence,
    });
  }

  viewAt(sequence: number): SessionHistoryView {
    return this.#snapshotFrom({
      events: this.#events.filter((record) => record.sequence <= sequence),
      modelHistory: this.#modelHistory.filter((record) => record.sequence <= sequence),
      nextSequence: sequence + 1,
    });
  }

  restore(snapshot: SessionSnapshot): void {
    if (snapshot.version !== "pss-session-v1") {
      throw new Error(`Unsupported session snapshot version: ${snapshot.version}`);
    }

    if (snapshot.sessionId !== this.#sessionId) {
      throw new Error(`Cannot restore snapshot for session ${snapshot.sessionId} into ${this.#sessionId}`);
    }

    this.#nextSequence = snapshot.nextSequence;
    this.#events = clone(snapshot.events);
    this.#modelHistory = clone(snapshot.modelHistory);
  }

  #snapshotFrom({
    events,
    modelHistory,
    nextSequence,
  }: {
    events: SessionEventRecord[];
    modelHistory: ModelHistoryRecord[];
    nextSequence: number;
  }): SessionSnapshot {
    return {
      version: "pss-session-v1",
      sessionId: this.#sessionId,
      nextSequence,
      events: clone(events),
      modelHistory: clone(modelHistory),
    };
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
