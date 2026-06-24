import type { ThreadCompactionRecord } from "../../thread/state/snapshot";
import { decodeStoredThreadState } from "../../thread/state/snapshot";
import type { ThreadStore } from "../../thread/store/types";

export interface ThreadInspectionCompaction {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
  readonly summaryBytes: number;
}

export interface ThreadInspection {
  readonly compactionCount: number;
  readonly compactions: readonly ThreadInspectionCompaction[];
  readonly exists: boolean;
  readonly messageCount: number;
  readonly summaryBytes: number;
  readonly threadKey: string;
  readonly version: string | null;
}

export interface ThreadInspectionOptions {
  readonly key: string;
  readonly store: ThreadStore;
}

export async function inspectStoredThread({
  key,
  store,
}: ThreadInspectionOptions): Promise<ThreadInspection> {
  const stored = await store.load(key);
  const state = decodeStoredThreadState(stored);
  const compactions = state.compactions.map(threadCompactionInspection);
  const summaryBytes = compactions.reduce(
    (total, record) => total + record.summaryBytes,
    0
  );

  return {
    compactionCount: compactions.length,
    compactions,
    exists: stored !== null,
    messageCount: state.history.length,
    summaryBytes,
    threadKey: key,
    version: stored?.version ?? null,
  };
}

function threadCompactionInspection(
  record: ThreadCompactionRecord
): ThreadInspectionCompaction {
  return {
    endSeqExclusive: record.endSeqExclusive,
    startSeq: record.startSeq,
    summaryBytes: jsonByteLength(record.summary),
  };
}

function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Thread compaction summary could not be encoded");
  }

  return new TextEncoder().encode(encoded).byteLength;
}
