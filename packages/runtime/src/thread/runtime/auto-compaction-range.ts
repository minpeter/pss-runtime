import type { ModelMessage } from "ai";
import { isRecord as isObjectRecord } from "../../internal/guards";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type {
  AutoCompactionRange,
  ThreadAutoCompactionOptions,
} from "./auto-compaction-types";

export function selectAutoCompactionRange({
  compactions,
  history,
  policy,
}: {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
  readonly policy: ThreadAutoCompactionOptions;
}): AutoCompactionRange | undefined {
  if (history.length < policy.minMessages) {
    return;
  }

  let endSeqExclusive = history.length - policy.retainMessages;
  while (
    endSeqExclusive > 0 &&
    !isSafeCompactionBoundary(history, endSeqExclusive)
  ) {
    endSeqExclusive -= 1;
  }

  if (endSeqExclusive <= 0) {
    return;
  }

  const alreadyCovered = compactions.some(
    (record) =>
      record.startSeq === 0 && record.endSeqExclusive >= endSeqExclusive
  );
  if (alreadyCovered) {
    return;
  }

  return { endSeqExclusive, startSeq: 0 };
}

function isSafeCompactionBoundary(
  history: readonly ModelMessage[],
  endSeqExclusive: number
): boolean {
  const previous = history[endSeqExclusive - 1];
  const next = history[endSeqExclusive];
  if (next?.role === "tool") {
    return false;
  }
  return previous?.role === "assistant" && !messageHasToolCall(previous);
}

function messageHasToolCall(message: ModelMessage | undefined): boolean {
  if (message?.role !== "assistant") {
    return false;
  }

  const content: unknown = message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some(
    (part) => isObjectRecord(part) && part.type === "tool-call"
  );
}
