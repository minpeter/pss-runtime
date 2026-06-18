import type { ModelMessage } from "ai";
import type { StoredThread } from "../store/types";

export interface AgentThreadSnapshotV1 {
  readonly history: ModelMessage[];
  readonly schemaVersion: 1;
}

export function encodeThreadSnapshot(
  history: ModelMessage[]
): AgentThreadSnapshotV1 {
  return { schemaVersion: 1, history: structuredClone(history) };
}

export function decodeStoredThreadSnapshot(
  stored: StoredThread | null
): ModelMessage[] {
  if (!stored) {
    return [];
  }

  const snapshot = stored.state;
  if (isThreadSnapshotV1(snapshot)) {
    return structuredClone(snapshot.history);
  }

  throw new Error("Unsupported stored thread state");
}

function isThreadSnapshotV1(value: unknown): value is AgentThreadSnapshotV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "history" in value &&
    Array.isArray(value.history)
  );
}
