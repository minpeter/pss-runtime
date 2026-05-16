import type { AgentEvent } from "./events";

export type SessionEventRecord = {
  sequence: number;
  event: AgentEvent;
};

export type ModelHistoryItem = Extract<
  AgentEvent,
  { type: "user-text" | "assistant-text" | "tool-call" }
>;

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

export function toModelHistoryItem(
  event: AgentEvent,
): ModelHistoryItem | undefined {
  if (
    event.type === "user-text" ||
    event.type === "assistant-text" ||
    event.type === "tool-call"
  ) {
    return event;
  }
}

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

  appendModelItem(
    sequence: number,
    item: ModelHistoryItem,
  ): ModelHistoryRecord {
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
    const maxSequence = this.#nextSequence - 1;

    if (sequence > maxSequence) {
      throw new Error(
        `Cannot view future sequence ${sequence} (current max is ${maxSequence})`,
      );
    }

    return this.#snapshotFrom({
      events: this.#events.filter((record) => record.sequence <= sequence),
      modelHistory: this.#modelHistory.filter(
        (record) => record.sequence <= sequence,
      ),
      nextSequence: sequence + 1,
    });
  }

  restore(snapshot: SessionSnapshot): void {
    if (snapshot.version !== "pss-session-v1") {
      throw new Error(
        `Unsupported session snapshot version: ${snapshot.version}`,
      );
    }

    if (snapshot.sessionId !== this.#sessionId) {
      throw new Error(
        `Cannot restore snapshot for session ${snapshot.sessionId} into ${this.#sessionId}`,
      );
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
