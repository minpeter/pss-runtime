import type { AgentEvent } from "./events";

export type SessionEventRecord = {
  sequence: number;
  event: AgentEvent;
};

export type ModelHistoryItem = Extract<
  AgentEvent,
  { type: "user-text" | "assistant-text" | "tool-call" }
>;
export type PendingUserInput = Extract<AgentEvent, { type: "user-text" }>;

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

  constructor(sessionId: string, snapshot?: SessionSnapshot) {
    this.#sessionId = sessionId;

    if (snapshot !== undefined) {
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

  modelHistory(): ModelHistoryItem[] {
    return replayEvents(this.#events).modelHistory.map((record) =>
      clone(record.item),
    );
  }

  pendingInputs(): PendingUserInput[] {
    return replayEvents(this.#events).pendingInputs;
  }

  snapshot(): SessionSnapshot {
    return this.#snapshotFrom({
      events: this.#events,
      nextSequence: this.#nextSequence,
    });
  }

  viewAt(sequence: number): SessionHistoryView {
    const maxSequence = this.#nextSequence - 1;

    assertViewSequence(sequence, maxSequence);

    return this.#snapshotFrom({
      events: this.#events.filter((record) => record.sequence <= sequence),
      nextSequence: sequence + 1,
    });
  }

  restore(snapshot: SessionSnapshot): void {
    assertValidSnapshot(snapshot, this.#sessionId);

    this.#nextSequence = snapshot.nextSequence;
    this.#events = clone(snapshot.events);
  }

  #snapshotFrom({
    events,
    nextSequence,
  }: {
    events: SessionEventRecord[];
    nextSequence: number;
  }): SessionSnapshot {
    const modelHistory = replayEvents(events).modelHistory;

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

function assertViewSequence(sequence: number, maxSequence: number): void {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > maxSequence
  ) {
    throw new Error(
      `Invalid history sequence ${sequence} (current max is ${maxSequence})`,
    );
  }
}

function assertValidSnapshot(
  snapshot: SessionSnapshot,
  sessionId: string,
): void {
  if (!isRecord(snapshot)) {
    throw new Error("Invalid session snapshot: expected an object");
  }

  if (snapshot.version !== "pss-session-v1") {
    throw new Error(`Unsupported session snapshot version: ${snapshot.version}`);
  }

  if (snapshot.sessionId !== sessionId) {
    throw new Error(
      `Cannot restore snapshot for session ${snapshot.sessionId} into ${sessionId}`,
    );
  }

  if (!Number.isSafeInteger(snapshot.nextSequence) || snapshot.nextSequence < 1) {
    throw new Error(`Invalid snapshot nextSequence: ${snapshot.nextSequence}`);
  }

  assertRecords({
    contiguous: true,
    label: "events",
    nextSequence: snapshot.nextSequence,
    records: snapshot.events,
    validateValue: (record) => assertAgentEvent(record.event),
  });
  assertRecords({
    label: "modelHistory",
    nextSequence: snapshot.nextSequence,
    records: snapshot.modelHistory,
    validateValue: (record) => assertModelHistoryItem(record.item),
  });
  assertModelHistoryMatchesEvents(snapshot.events, snapshot.modelHistory);
}

function assertRecords<T extends { sequence: number }>({
  contiguous = false,
  label,
  nextSequence,
  records,
  validateValue,
}: {
  contiguous?: boolean;
  label: string;
  nextSequence: number;
  records: T[];
  validateValue: (record: T) => void;
}): void {
  if (!Array.isArray(records)) {
    throw new Error(`Invalid ${label}: expected an array`);
  }

  let previousSequence = 0;
  let expectedSequence = 1;

  for (const record of records) {
    if (
      !isRecord(record) ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence <= previousSequence ||
      record.sequence >= nextSequence ||
      (contiguous && record.sequence !== expectedSequence)
    ) {
      throw new Error(
        `Invalid ${label} sequence: ${String(
          isRecord(record) ? record.sequence : undefined,
        )}`,
      );
    }

    validateValue(record);
    previousSequence = record.sequence;
    expectedSequence += 1;
  }

  if (contiguous && expectedSequence !== nextSequence) {
    throw new Error(
      `Invalid ${label} sequence: expected ${expectedSequence} before nextSequence ${nextSequence}`,
    );
  }
}

function assertModelHistoryMatchesEvents(
  events: SessionEventRecord[],
  modelHistory: ModelHistoryRecord[],
): void {
  const expected = replayEvents(events).modelHistory;

  if (JSON.stringify(modelHistory) !== JSON.stringify(expected)) {
    throw new Error("Invalid modelHistory: does not match event replay");
  }
}

function replayEvents(events: SessionEventRecord[]): {
  modelHistory: ModelHistoryRecord[];
  pendingInputs: PendingUserInput[];
} {
  const pendingInputs: PendingUserInput[] = [];
  let activeTurnHistory: ModelHistoryRecord[] | undefined;
  const modelHistory: ModelHistoryRecord[] = [];

  for (const record of events) {
    if (record.event.type === "user-text") {
      pendingInputs.push(clone(record.event));
      continue;
    }

    if (record.event.type === "turn-start") {
      const input = pendingInputs.shift();

      if (!input) {
        throw new Error(
          `Invalid events: turn-start at sequence ${record.sequence} has no pending user input`,
        );
      }

      activeTurnHistory = [{ sequence: record.sequence, item: clone(input) }];
      continue;
    }

    if (record.event.type === "turn-end") {
      if (activeTurnHistory) {
        modelHistory.push(...activeTurnHistory.map((item) => clone(item)));
        activeTurnHistory = undefined;
      }

      continue;
    }

    if (
      record.event.type === "turn-abort" ||
      record.event.type === "turn-error"
    ) {
      const userInput = activeTurnHistory?.[0];

      if (userInput) {
        modelHistory.push(clone(userInput));
      }

      activeTurnHistory = undefined;
      continue;
    }

    const item = toModelHistoryItem(record.event);

    if (item) {
      activeTurnHistory?.push({ sequence: record.sequence, item: clone(item) });
    }
  }

  return {
    modelHistory: [
      ...modelHistory,
      ...(activeTurnHistory ?? []).map((item) => clone(item)),
    ],
    pendingInputs: pendingInputs.map((input) => clone(input)),
  };
}

function assertAgentEvent(event: AgentEvent): void {
  if (!isRecord(event)) {
    throw new Error("Invalid agent event: expected an object");
  }

  switch (event.type) {
    case "user-text":
    case "assistant-text":
      assertString(event.text, event.type, "text");
      return;
    case "tool-call":
      assertString(event.toolName, event.type, "toolName");
      return;
    case "turn-error":
      assertString(event.message, event.type, "message");
      return;
    case "turn-start":
    case "turn-abort":
    case "turn-end":
    case "step-start":
    case "step-end":
      return;
    default:
      throw new Error(
        `Invalid agent event type: ${String(
          (event as { type?: unknown }).type,
        )}`,
      );
  }
}

function assertModelHistoryItem(item: ModelHistoryItem): void {
  if (!isRecord(item)) {
    throw new Error("Invalid model history item: expected an object");
  }

  switch (item.type) {
    case "user-text":
    case "assistant-text":
      assertString(item.text, item.type, "text");
      return;
    case "tool-call":
      assertString(item.toolName, item.type, "toolName");
      return;
    default:
      throw new Error(
        `Invalid model history item type: ${String(
          (item as { type?: unknown }).type,
        )}`,
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertString(value: unknown, eventType: string, field: string): void {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${eventType}.${field}: expected a string`);
  }
}
