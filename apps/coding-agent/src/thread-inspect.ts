import { join } from "node:path";
import { FileThreadStore } from "@minpeter/pss-runtime/thread-store/file";
import { z } from "zod";
import type { CodingAgentThreadConfig } from "./thread-config";

const modelMessageSchema = z
  .object({
    content: z.unknown(),
    role: z.enum(["system", "user", "assistant", "tool"]),
  })
  .passthrough();

const compactionSchema = z
  .object({
    endSeqExclusive: z.number().int(),
    schemaVersion: z.literal(1),
    startSeq: z.number().int().nonnegative(),
    summary: modelMessageSchema,
  })
  .passthrough();

const snapshotV1Schema = z
  .object({
    history: z.array(modelMessageSchema),
    schemaVersion: z.literal(1),
  })
  .passthrough();

const snapshotV2Schema = z
  .object({
    compactions: z.array(compactionSchema),
    history: z.array(modelMessageSchema),
    schemaVersion: z.literal(2),
  })
  .passthrough();

const snapshotSchema = z.union([snapshotV1Schema, snapshotV2Schema]);

type ThreadSnapshot = z.infer<typeof snapshotSchema>;
type ThreadCompaction = z.infer<typeof compactionSchema>;

export interface ThreadInspectionCompaction {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
  readonly summaryBytes: number;
}

export interface ThreadInspectionReport {
  readonly autoCompaction: CodingAgentThreadConfig["autoCompaction"];
  readonly compactionCount: number;
  readonly compactions: readonly ThreadInspectionCompaction[];
  readonly messageCount: number;
  readonly storageFile: string;
  readonly summaryBytes: number;
  readonly threadKey: string;
}

export async function inspectCodingAgentThread(
  config: CodingAgentThreadConfig
): Promise<ThreadInspectionReport> {
  const stored = await new FileThreadStore(config.directory).load(config.key);
  const state = decodeThreadState(stored?.state);
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
    autoCompaction: config.autoCompaction,
    compactionCount: compactions.length,
    compactions,
    messageCount: state.messageCount,
    storageFile: storageFileForThread(config.directory, config.key),
    summaryBytes,
    threadKey: config.key,
  };
}

export function formatThreadInspectionReport(
  report: ThreadInspectionReport
): string {
  const compactions =
    report.compactions.length === 0
      ? "compactions: none"
      : `compactions:\n${report.compactions
          .map(
            (record) =>
              `  - startSeq=${record.startSeq} endSeqExclusive=${record.endSeqExclusive} summaryBytes=${record.summaryBytes}`
          )
          .join("\n")}`;

  return [
    `threadKey: ${report.threadKey}`,
    `storageFile: ${report.storageFile}`,
    `messageCount: ${report.messageCount}`,
    `compactionCount: ${report.compactionCount}`,
    compactions,
    `summaryBytes: ${report.summaryBytes}`,
    `autoCompaction: ${formatAutoCompaction(report.autoCompaction)}`,
  ].join("\n");
}

export function storageFileForThread(directory: string, key: string): string {
  return join(directory, `${Buffer.from(key).toString("base64url")}.json`);
}

function decodeThreadState(state: unknown): {
  readonly compactions: readonly ThreadCompaction[];
  readonly messageCount: number;
} {
  if (state === undefined) {
    return { compactions: [], messageCount: 0 };
  }

  const parsed = snapshotSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error("Unsupported stored thread state");
  }

  validateSnapshotCompactions(parsed.data);

  if (parsed.data.schemaVersion === 1) {
    return { compactions: [], messageCount: parsed.data.history.length };
  }

  return {
    compactions: parsed.data.compactions,
    messageCount: parsed.data.history.length,
  };
}

function validateSnapshotCompactions(snapshot: ThreadSnapshot): void {
  if (snapshot.schemaVersion !== 2) {
    return;
  }

  for (const record of snapshot.compactions) {
    if (record.endSeqExclusive <= record.startSeq) {
      throw new Error(
        "Thread compaction endSeqExclusive must be greater than startSeq"
      );
    }
    if (record.endSeqExclusive > snapshot.history.length) {
      throw new Error("Thread compaction range exceeds thread history");
    }
  }
}

function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Thread compaction summary could not be encoded");
  }

  return Buffer.byteLength(encoded, "utf8");
}

function formatAutoCompaction(
  autoCompaction: CodingAgentThreadConfig["autoCompaction"]
): string {
  return autoCompaction
    ? `min=${autoCompaction.minMessages} retain=${autoCompaction.retainMessages}`
    : "off";
}
