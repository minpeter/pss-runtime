import type {
  Checkpoint,
  NotificationRecord,
  StoredAgentEvent,
  TurnRecord,
} from "../../../execution/host/types";
import type { StoredThread } from "../../../thread/store/types";

export interface ExecutionState {
  readonly checkpoints: Map<string, Checkpoint[]>;
  readonly events: Map<string, StoredAgentEvent[]>;
  readonly notificationsByKey: Map<string, NotificationRecord>;
  readonly threads: Map<string, StoredThread>;
  readonly threadVersions: Map<string, number>;
  readonly turns: Map<string, TurnRecord>;
}

export function createEmptyState(): ExecutionState {
  return {
    checkpoints: new Map(),
    events: new Map(),
    notificationsByKey: new Map(),
    turns: new Map(),
    threadVersions: new Map(),
    threads: new Map(),
  };
}

export function cloneState(state: ExecutionState): ExecutionState {
  return {
    checkpoints: cloneCheckpointMap(state.checkpoints),
    events: cloneEventMap(state.events),
    notificationsByKey: cloneRecordMap(state.notificationsByKey),
    turns: cloneRecordMap(state.turns),
    threadVersions: cloneRecordMap(state.threadVersions),
    threads: cloneRecordMap(state.threads),
  };
}

function cloneCheckpointMap(
  map: ReadonlyMap<string, readonly Checkpoint[]>
): Map<string, Checkpoint[]> {
  return new Map(
    [...map.entries()].map(([key, value]) => [
      key,
      value.map((checkpoint) => structuredClone(checkpoint)),
    ])
  );
}

function cloneEventMap(
  map: ReadonlyMap<string, readonly StoredAgentEvent[]>
): Map<string, StoredAgentEvent[]> {
  return new Map(
    [...map.entries()].map(([key, value]) => [
      key,
      value.map((event) => structuredClone(event)),
    ])
  );
}

function cloneRecordMap<T>(map: ReadonlyMap<string, T>): Map<string, T> {
  return new Map(
    [...map.entries()].map(([key, value]) => [key, structuredClone(value)])
  );
}
