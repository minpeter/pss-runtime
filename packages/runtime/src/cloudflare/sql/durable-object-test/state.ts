export interface ThreadMetaRow {
  readonly message_count: number;
  readonly next_seq: number;
  readonly session_key: string;
  readonly state_blob: string | null;
  readonly version: number | string;
}

export interface ThreadMessageRow {
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

export interface ScheduledWorkRow {
  readonly created_at: number;
  readonly kind: string;
  readonly payload: string;
  readonly prefix: string;
  readonly work_id: string;
}

export interface InMemoryDurableObjectSqlState {
  checkpoints: CheckpointRow[];
  eventMeta: Map<string, EventMetaRow>;
  events: EventRow[];
  scheduledWork: ScheduledWorkRow[];
  threadMessages: ThreadMessageRow[];
  threadMeta: Map<string, ThreadMetaRow>;
}

export function createInMemoryDurableObjectSqlState(): InMemoryDurableObjectSqlState {
  return {
    checkpoints: [],
    eventMeta: new Map(),
    events: [],
    scheduledWork: [],
    threadMessages: [],
    threadMeta: new Map(),
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
    scheduledWork: structuredClone(state.scheduledWork),
    threadMessages: structuredClone(state.threadMessages),
    threadMeta: new Map(
      [...state.threadMeta].map(([key, value]) => [key, structuredClone(value)])
    ),
  };
}
