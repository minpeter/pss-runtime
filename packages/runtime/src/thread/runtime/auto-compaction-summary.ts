import type { ModelMessage } from "ai";
import { generateModelStep } from "../../llm/model-step";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { ThreadContextMessage } from "../state/context";
import { ModelMessageHistory } from "../state/history";
import type { ThreadCompactionRecord } from "../state/snapshot";
import { messageContentText } from "./auto-compaction-message-text";
import type {
  AutoCompactionRange,
  ThreadModelContextTransform,
} from "./auto-compaction-types";

export async function summarizeCompactionRange({
  history,
  model,
  transformModelContext,
}: {
  readonly history: readonly ThreadContextMessage[];
  readonly model: ModelGenerationOptions;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<string> {
  const signal = new AbortController().signal;
  const summaryHistory: readonly ThreadContextMessage[] = [
    {
      content:
        "Summarize the following prior thread messages for future turns. Preserve durable facts, user preferences, decisions, unresolved tasks, and tool results. Be concise.",
      role: "system",
    },
    ...history,
  ];
  const output = await generateModelStep({
    attachmentStore: model.attachmentStore,
    contextGate: false,
    history: transformModelContext
      ? await transformModelContext(summaryHistory, signal)
      : summaryHistory,
    instructions: model.instructions,
    model: model.model,
    signal,
  });
  return output
    .flatMap((message) =>
      message.role === "assistant" ? messageContentText(message.content) : []
    )
    .join("\n\n")
    .trim();
}

export function summaryHistoryForRange({
  compactions,
  history,
  range,
}: {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
  readonly range: AutoCompactionRange;
}): ThreadContextMessage[] {
  const prefixHistory = history.slice(range.startSeq, range.endSeqExclusive);
  if (range.startSeq !== 0) {
    return structuredClone(prefixHistory);
  }

  const prefixCompactions = compactions.filter(
    (record) => record.endSeqExclusive <= range.endSeqExclusive
  );
  return new ModelMessageHistory(
    prefixHistory,
    undefined,
    prefixCompactions
  ).modelContextSnapshot();
}
