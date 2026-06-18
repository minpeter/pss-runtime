export interface SessionMetaRow {
  readonly message_count: number;
  readonly next_seq: number;
  readonly session_key: string;
  readonly state_blob: string | null;
  readonly version: number | string;
}

export interface SessionMessageRow {
  active: number;
  readonly message: string;
  readonly seq: number;
  readonly session_key: string;
}

export interface EventMetaRow {
  readonly next_seq: number;
  readonly run_key: string;
}

export interface EventRow {
  readonly event: string;
  readonly run_key: string;
  readonly seq: number;
}

export interface CheckpointRow {
  readonly checkpoint: string;
  readonly run_key: string;
  readonly version: number;
}

export interface InMemoryDurableObjectSqlState {
  checkpoints: CheckpointRow[];
  eventMeta: Map<string, EventMetaRow>;
  events: EventRow[];
  sessionMessages: SessionMessageRow[];
  sessionMeta: Map<string, SessionMetaRow>;
}

export function createInMemoryDurableObjectSqlState(): InMemoryDurableObjectSqlState {
  return {
    checkpoints: [],
    eventMeta: new Map(),
    events: [],
    sessionMessages: [],
    sessionMeta: new Map(),
  };
}

export function cloneInMemoryDurableObjectSqlState(
  state: InMemoryDurableObjectSqlState
): InMemoryDurableObjectSqlState {
  return {
    checkpoints: structuredClone(state.checkpoints),
    eventMeta: new Map(
      [...state.eventMeta].map(([key, value]) => [key, structuredClone(value)])
    ),
    events: structuredClone(state.events),
    sessionMessages: structuredClone(state.sessionMessages),
    sessionMeta: new Map(
      [...state.sessionMeta].map(([key, value]) => [
        key,
        structuredClone(value),
      ])
    ),
  };
}
