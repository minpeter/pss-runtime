import type { ModelMessage } from "ai";
import type { StoredSession } from "./store/types";

export interface AgentSessionSnapshotV1 {
  readonly history: ModelMessage[];
  readonly schemaVersion: 1;
}

export type AgentSessionSnapshot = AgentSessionSnapshotV1;

export function encodeSessionSnapshot(
  history: ModelMessage[]
): AgentSessionSnapshot {
  return { schemaVersion: 1, history: structuredClone(history) };
}

export function decodeStoredSessionSnapshot(
  stored: StoredSession | null
): ModelMessage[] {
  if (!stored) {
    return [];
  }

  const snapshot = stored.state;
  if (isSessionSnapshotV1(snapshot)) {
    return structuredClone(snapshot.history);
  }

  throw new Error("Unsupported stored session state");
}

function isSessionSnapshotV1(value: unknown): value is AgentSessionSnapshotV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "history" in value &&
    Array.isArray(value.history)
  );
}
