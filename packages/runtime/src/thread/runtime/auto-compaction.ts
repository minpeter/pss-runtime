import type { ModelMessage } from "ai";
import { generateModelStep, type ModelGenerationOptions } from "../../llm/llm";
import { ModelMessageHistory } from "../state/history";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { ThreadState } from "../state/thread-state";

export interface ThreadAutoCompactionOptions {
  readonly minMessages: number;
  readonly retainMessages: number;
}

interface AutoCompactionRange {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
}

const activeCompactions = new WeakSet<ThreadState>();

export function scheduleThreadAutoCompaction({
  model,
  policy,
  state,
}: {
  readonly model: ModelGenerationOptions;
  readonly policy?: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
}): void {
  if (!policy) {
    return;
  }

  if (activeCompactions.has(state)) {
    return;
  }
  activeCompactions.add(state);
  queueMicrotask(() => {
    const backgroundCompaction = compactThreadInBackground({
      model,
      policy,
      state,
    }).finally(() => {
      activeCompactions.delete(state);
    });
    backgroundCompaction.catch(() => undefined);
  });
}

async function compactThreadInBackground({
  model,
  policy,
  state,
}: {
  readonly model: ModelGenerationOptions;
  readonly policy: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
}): Promise<void> {
  try {
    let compacted = await compactThreadOnce({ model, policy, state });
    while (compacted) {
      compacted = await compactThreadOnce({ model, policy, state });
    }
  } catch {
    return;
  }
}

export async function compactThreadBlocking({
  model,
  policy,
  state,
}: {
  readonly model: ModelGenerationOptions;
  readonly policy?: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
}): Promise<boolean> {
  if (!policy) {
    return false;
  }

  return await compactThreadOnce({ model, policy, state });
}

async function compactThreadOnce({
  model,
  policy,
  state,
}: {
  readonly model: ModelGenerationOptions;
  readonly policy: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
}): Promise<boolean> {
  for (;;) {
    const history = state.modelSnapshot();
    const compactions = state.compactionSnapshot();
    const range = selectAutoCompactionRange({
      compactions,
      history,
      policy,
    });
    if (!range) {
      return false;
    }

    const summary = await summarizeCompactionRange({
      history: summaryHistoryForRange({ compactions, history, range }),
      model,
    });
    if (summary.length === 0) {
      return false;
    }

    const latestRange = selectAutoCompactionRange({
      compactions: state.compactionSnapshot(),
      history: state.modelSnapshot(),
      policy,
    });
    if (!sameRange(range, latestRange)) {
      continue;
    }

    await state.compact({ ...range, summary });
    return true;
  }
}

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

async function summarizeCompactionRange({
  history,
  model,
}: {
  readonly history: readonly ModelMessage[];
  readonly model: ModelGenerationOptions;
}): Promise<string> {
  const output = await generateModelStep({
    attachmentStore: model.attachmentStore,
    history: [
      {
        content:
          "Summarize the following prior thread messages for future turns. Preserve durable facts, user preferences, decisions, unresolved tasks, and tool results. Be concise.",
        role: "system",
      },
      ...history,
    ],
    instructions: model.instructions,
    model: model.model,
    signal: new AbortController().signal,
  });
  return output
    .flatMap((message) =>
      message.role === "assistant" ? messageContentText(message.content) : []
    )
    .join("\n\n")
    .trim();
}

function summaryHistoryForRange({
  compactions,
  history,
  range,
}: {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
  readonly range: AutoCompactionRange;
}): ModelMessage[] {
  const prefixHistory = history.slice(range.startSeq, range.endSeqExclusive);
  if (range.startSeq !== 0) {
    return prefixHistory.map((message) => structuredClone(message));
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

function sameRange(
  left: AutoCompactionRange,
  right: AutoCompactionRange | undefined
): boolean {
  return (
    right !== undefined &&
    left.startSeq === right.startSeq &&
    left.endSeqExclusive === right.endSeqExclusive
  );
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

function messageContentText(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [JSON.stringify(content)];
  }

  return content.flatMap((part) => {
    if (typeof part === "string") {
      return [part];
    }
    if (isObjectRecord(part) && typeof part.text === "string") {
      return [part.text];
    }
    return [];
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
