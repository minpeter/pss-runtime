import { join } from "node:path";
import { decodeStoredThreadState } from "../../../thread/state/snapshot";
import { createFileHost } from "../host/file-host";
import {
  currentDataDirectory,
  INITIAL_GENERATION_ID,
} from "./file-execution-store/generation";

export interface FileThreadInspectionOptions {
  readonly directory: string;
  readonly key: string;
}

export interface FileThreadInspectionCompaction {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
  readonly summaryBytes: number;
}

export interface FileThreadInspection {
  readonly compactionCount: number;
  readonly compactions: readonly FileThreadInspectionCompaction[];
  readonly messageCount: number;
  readonly storageFile: string;
  readonly summaryBytes: number;
  readonly threadKey: string;
  readonly version: string | null;
}

export async function inspectFileThread({
  directory,
  key,
}: FileThreadInspectionOptions): Promise<FileThreadInspection> {
  const host = createFileHost({ directory });
  const stored = await host.store.threads.load(key);
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
    storageFile: await fileThreadStorageHint({ directory, key }),
    summaryBytes,
    threadKey: key,
    version: stored?.version ?? null,
  };
}

/** Best-effort path under the current generation's threads directory. */
export async function fileThreadStorageHint(
  options: FileThreadInspectionOptions
): Promise<string> {
  const dataDirectory = await currentDataDirectory(options.directory).catch(
    () => join(options.directory, "generations", INITIAL_GENERATION_ID)
  );
  return join(
    dataDirectory,
    "threads",
    `${Buffer.from(options.key).toString("base64url")}.json`
  );
}

/** Sync path assuming the default main generation layout. */
export function fileThreadStoragePath({
  directory,
  key,
}: FileThreadInspectionOptions): string {
  return join(
    directory,
    "generations",
    INITIAL_GENERATION_ID,
    "threads",
    `${Buffer.from(key).toString("base64url")}.json`
  );
}

function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Thread compaction summary could not be encoded");
  }

  return Buffer.byteLength(encoded, "utf8");
}
