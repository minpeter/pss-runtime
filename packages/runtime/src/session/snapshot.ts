import type { ModelMessage } from "ai";
import type { StoredSession } from "./store/types";

export interface AgentSessionSnapshotV1 {
  readonly history: ModelMessage[];
  readonly schemaVersion: 1;
}

export interface AgentCompactionOverlay {
  readonly createdAt: string;
  readonly endIndex: number;
  readonly id: string;
  readonly startIndex: number;
  readonly summary: string;
}

export interface AgentSessionSnapshotV2 {
  readonly compactions: AgentCompactionOverlay[];
  readonly history: ModelMessage[];
  readonly pluginState: Record<string, unknown>;
  readonly schemaVersion: 2;
}

export interface AgentSessionSnapshotState {
  readonly compactions?: readonly AgentCompactionOverlay[];
  readonly history: readonly ModelMessage[];
  readonly pluginState?: Readonly<Record<string, unknown>>;
}

export type AgentSessionSnapshot = AgentSessionSnapshotV2;

export interface DecodedSessionSnapshot {
  readonly compactions: AgentCompactionOverlay[];
  readonly history: ModelMessage[];
  readonly pluginState: Record<string, unknown>;
}

export function encodeSessionSnapshot(
  state: AgentSessionSnapshotState
): AgentSessionSnapshot {
  return {
    compactions: structuredClone([...(state.compactions ?? [])]),
    history: structuredClone([...state.history]),
    pluginState: structuredClone({ ...(state.pluginState ?? {}) }),
    schemaVersion: 2,
  };
}

export function decodeStoredSessionSnapshot(
  stored: StoredSession | null
): DecodedSessionSnapshot {
  if (!stored) {
    return emptySnapshotState();
  }

  const snapshot = stored.state;
  if (isSessionSnapshotV1(snapshot)) {
    return {
      ...emptySnapshotState(),
      history: structuredClone(snapshot.history),
    };
  }

  if (isSessionSnapshotV2(snapshot)) {
    return {
      compactions: structuredClone(snapshot.compactions),
      history: structuredClone(snapshot.history),
      pluginState: structuredClone(snapshot.pluginState),
    };
  }

  throw new Error("Unsupported stored session state");
}

function emptySnapshotState(): DecodedSessionSnapshot {
  return { compactions: [], history: [], pluginState: {} };
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

function isSessionSnapshotV2(value: unknown): value is AgentSessionSnapshotV2 {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 2 &&
    "history" in value &&
    Array.isArray(value.history) &&
    "pluginState" in value &&
    isRecord(value.pluginState) &&
    "compactions" in value &&
    Array.isArray(value.compactions) &&
    value.compactions.every(isCompactionOverlay)
  );
}

function isCompactionOverlay(value: unknown): value is AgentCompactionOverlay {
  return (
    value !== null &&
    typeof value === "object" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "endIndex" in value &&
    typeof value.endIndex === "number" &&
    "id" in value &&
    typeof value.id === "string" &&
    "startIndex" in value &&
    typeof value.startIndex === "number" &&
    "summary" in value &&
    typeof value.summary === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
