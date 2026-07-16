import type { ModelMessage } from "ai";
import type { ThreadCompactionRecord } from "./snapshot";

export interface CompactionContextMessage {
  readonly endSeqExclusive: number;
  readonly role: "compaction";
  readonly startSeq: number;
  readonly summary: string;
}

export type ThreadContextMessage = ModelMessage | CompactionContextMessage;

export function compactionContextMessage(
  record: ThreadCompactionRecord
): CompactionContextMessage {
  return {
    endSeqExclusive: record.endSeqExclusive,
    role: "compaction",
    startSeq: record.startSeq,
    summary: summaryText(record.summary.content),
  };
}

export function compactionContextForModel(
  message: CompactionContextMessage
): ModelMessage {
  return {
    content: `The conversation history before this point was compacted into the following summary:\n<summary>\n${message.summary}\n</summary>`,
    role: "user",
  };
}

export function isCompactionContextMessage(
  value: unknown
): value is CompactionContextMessage {
  if (!(value && typeof value === "object")) {
    return false;
  }
  if (
    !("startSeq" in value) ||
    typeof value.startSeq !== "number" ||
    !("endSeqExclusive" in value) ||
    typeof value.endSeqExclusive !== "number"
  ) {
    return false;
  }
  return (
    "role" in value &&
    value.role === "compaction" &&
    "summary" in value &&
    typeof value.summary === "string" &&
    Number.isInteger(value.startSeq) &&
    value.startSeq >= 0 &&
    Number.isInteger(value.endSeqExclusive) &&
    value.endSeqExclusive > value.startSeq
  );
}

function summaryText(content: ModelMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}
