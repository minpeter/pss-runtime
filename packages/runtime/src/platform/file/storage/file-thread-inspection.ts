import { join } from "node:path";
import { decodeStoredThreadState } from "../../../thread/state/snapshot";
import { FileThreadStore } from "./file-thread-store";

export interface NodeFileThreadInspectionOptions {
  readonly directory: string;
  readonly key: string;
}

export interface NodeFileThreadInspectionCompaction {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
  readonly summaryBytes: number;
}

export interface NodeFileThreadInspection {
  readonly compactionCount: number;
  readonly compactions: readonly NodeFileThreadInspectionCompaction[];
  readonly messageCount: number;
  readonly storageFile: string;
  readonly summaryBytes: number;
  readonly threadKey: string;
  readonly version: string | null;
}

export async function inspectNodeFileThread({
  directory,
  key,
}: NodeFileThreadInspectionOptions): Promise<NodeFileThreadInspection> {
  const stored = await new FileThreadStore(directory).load(key);
  const state = decodeStoredThreadState(stored);
  const compactions = state.compactions.map((record) => ({
    endSeqExclusive: record.endSeqExclusive,
    startSeq: record.startSeq,
    summaryBytes: jsonByteLength(record.summary),
  }));
  const summaryBytes = compactions.reduce(
    (total, record) => total + record.summaryBytes,
    0
  );

  return {
    compactionCount: compactions.length,
    compactions,
    messageCount: state.history.length,
    storageFile: nodeFileThreadStorageFile({ directory, key }),
    summaryBytes,
    threadKey: key,
    version: stored?.version ?? null,
  };
}

export function nodeFileThreadStorageFile({
  directory,
  key,
}: NodeFileThreadInspectionOptions): string {
  return join(directory, `${Buffer.from(key).toString("base64url")}.json`);
}

function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Thread compaction summary could not be encoded");
  }

  return Buffer.byteLength(encoded, "utf8");
}
