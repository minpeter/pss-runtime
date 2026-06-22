import type { ModelMessage } from "ai";
import type { StoredThread } from "../store/types";

export interface AgentThreadSnapshotV1 {
  readonly history: ModelMessage[];
  readonly schemaVersion: 1;
}

export interface ThreadCompactionRecord {
  readonly endSeqExclusive: number;
  readonly schemaVersion: 1;
  readonly startSeq: number;
  readonly summary: ModelMessage;
}

export interface AgentThreadSnapshotV2 {
  readonly compactions: ThreadCompactionRecord[];
  readonly history: ModelMessage[];
  readonly schemaVersion: 2;
}

export type AgentThreadSnapshot = AgentThreadSnapshotV1 | AgentThreadSnapshotV2;

export interface DecodedThreadState {
  readonly compactions: ThreadCompactionRecord[];
  readonly history: ModelMessage[];
}

export class ThreadCompactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadCompactionValidationError";
  }
}

export function encodeThreadSnapshot(
  history: ModelMessage[],
  compactions: readonly ThreadCompactionRecord[] = []
): AgentThreadSnapshot {
  const clonedHistory = structuredClone(history);
  if (compactions.length === 0) {
    return { schemaVersion: 1, history: clonedHistory };
  }

  const clonedCompactions = compactions.map((record) =>
    validateThreadCompactionRecord(record, clonedHistory.length)
  );
  return {
    compactions: clonedCompactions,
    history: clonedHistory,
    schemaVersion: 2,
  };
}

export function decodeStoredThreadSnapshot(
  stored: StoredThread | null
): ModelMessage[] {
  return decodeStoredThreadState(stored).history;
}

export function decodeStoredThreadState(
  stored: StoredThread | null
): DecodedThreadState {
  if (!stored) {
    return { compactions: [], history: [] };
  }

  const snapshot = stored.state;
  if (isThreadSnapshotV1(snapshot)) {
    return { compactions: [], history: structuredClone(snapshot.history) };
  }

  if (isThreadSnapshotV2(snapshot)) {
    const history = structuredClone(snapshot.history);
    const compactions = snapshot.compactions.map((record) =>
      validateThreadCompactionRecord(record, history.length)
    );
    return { compactions, history };
  }

  throw new Error("Unsupported stored thread state");
}

export function isAgentThreadSnapshot(
  value: unknown
): value is AgentThreadSnapshot {
  return isThreadSnapshotV1(value) || isThreadSnapshotV2(value);
}

export function validateThreadCompactionRecord(
  record: ThreadCompactionRecord,
  historyLength?: number
): ThreadCompactionRecord {
  if (record.schemaVersion !== 1) {
    throw new ThreadCompactionValidationError(
      "Unsupported thread compaction schema version"
    );
  }
  if (!Number.isInteger(record.startSeq) || record.startSeq < 0) {
    throw new ThreadCompactionValidationError(
      "Thread compaction startSeq must be a non-negative integer"
    );
  }
  if (
    !Number.isInteger(record.endSeqExclusive) ||
    record.endSeqExclusive <= record.startSeq
  ) {
    throw new ThreadCompactionValidationError(
      "Thread compaction endSeqExclusive must be greater than startSeq"
    );
  }
  if (historyLength !== undefined && record.endSeqExclusive > historyLength) {
    throw new ThreadCompactionValidationError(
      "Thread compaction range exceeds thread history"
    );
  }
  if (!isModelMessage(record.summary)) {
    throw new ThreadCompactionValidationError(
      "Thread compaction summary must be a model message"
    );
  }

  return structuredClone(record);
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

function isThreadSnapshotV2(value: unknown): value is AgentThreadSnapshotV2 {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 2 &&
    "history" in value &&
    Array.isArray(value.history) &&
    "compactions" in value &&
    Array.isArray(value.compactions) &&
    value.compactions.every(isThreadCompactionRecordShape)
  );
}

function isThreadCompactionRecordShape(
  value: unknown
): value is ThreadCompactionRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "startSeq" in value &&
    typeof value.startSeq === "number" &&
    "endSeqExclusive" in value &&
    typeof value.endSeqExclusive === "number" &&
    "summary" in value &&
    isModelMessage(value.summary)
  );
}

function isModelMessage(value: unknown): value is ModelMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    "role" in value &&
    typeof value.role === "string" &&
    (value.role === "system" ||
      value.role === "user" ||
      value.role === "assistant" ||
      value.role === "tool") &&
    "content" in value
  );
}
