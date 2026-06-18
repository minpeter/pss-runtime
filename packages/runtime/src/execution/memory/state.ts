import type { StoredThread } from "../../thread/store/types";
import type {
  NotificationRecord,
  RunCheckpoint,
  RunRecord,
  StoredAgentEvent,
} from "../host/types";

export interface ExecutionState {
  readonly checkpoints: Map<string, RunCheckpoint[]>;
  readonly events: Map<string, StoredAgentEvent[]>;
  readonly notificationsByKey: Map<string, NotificationRecord>;
  readonly runs: Map<string, RunRecord>;
  readonly threads: Map<string, StoredThread>;
  readonly threadVersions: Map<string, number>;
}

export function createEmptyState(): ExecutionState {
  return {
    checkpoints: new Map(),
    events: new Map(),
    notificationsByKey: new Map(),
    runs: new Map(),
    threadVersions: new Map(),
    threads: new Map(),
  };
}

export function cloneState(state: ExecutionState): ExecutionState {
  return {
    checkpoints: cloneCheckpointMap(state.checkpoints),
    events: cloneEventMap(state.events),
    notificationsByKey: cloneRecordMap(state.notificationsByKey),
    runs: cloneRecordMap(state.runs),
    threadVersions: cloneRecordMap(state.threadVersions),
    threads: cloneRecordMap(state.threads),
  };
}

function cloneCheckpointMap(
  map: ReadonlyMap<string, readonly RunCheckpoint[]>
): Map<string, RunCheckpoint[]> {
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
