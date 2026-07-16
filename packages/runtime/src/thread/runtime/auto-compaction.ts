import type { ModelMessage } from "ai";
import {
  generateModelStep,
  type ModelContextGateOptions,
  type ModelGenerationOptions,
} from "../../llm/llm";
import { ModelMessageHistory } from "../state/history";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { ThreadCompactionInput, ThreadState } from "../state/thread-state";
import { messageContentText } from "./auto-compaction-message-text";

export interface ThreadAutoCompactionOptions {
  readonly background?: boolean;
  readonly contextGate?: false | ModelContextGateOptions;
  readonly minMessages: number;
  readonly retainMessages: number;
}

export type ThreadModelContextTransform = (
  messages: readonly ModelMessage[],
  signal: AbortSignal
) => Promise<readonly ModelMessage[]>;

interface AutoCompactionRange {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
}

const activeCompactions = new WeakSet<ThreadState>();

export function scheduleThreadAutoCompaction({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy?: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): void {
  if (!policy || policy.background === false) {
    return;
  }

  if (activeCompactions.has(state)) {
    return;
  }
  activeCompactions.add(state);
  queueMicrotask(() => {
    const backgroundCompaction = compactThreadInBackground({
      compact,
      model,
      policy,
      state,
      transformModelContext,
    }).finally(() => {
      activeCompactions.delete(state);
    });
    backgroundCompaction.catch(() => undefined);
  });
}

async function compactThreadInBackground({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<void> {
  try {
    let compacted = await compactThreadOnce({
      compact,
      model,
      policy,
      state,
      transformModelContext,
    });
    while (compacted) {
      compacted = await compactThreadOnce({
        compact,
        model,
        policy,
        state,
        transformModelContext,
      });
    }
  } catch {
    return;
  }
}

export async function compactThreadBlocking({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy?: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<boolean> {
  if (!policy) {
    return false;
  }

  return await compactThreadOnce({
    compact,
    model,
    policy,
    state,
    transformModelContext,
  });
}

async function compactThreadOnce({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
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
      history: summaryHistoryForRange({ compactions, history, range, state }),
      model,
      transformModelContext,
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

    const input = { ...range, summary };
    if (compact) {
      return await compact(input);
    }
    await state.compact(input);
    return true;
  }
}

type ThreadCompactionHandler = (
  input: ThreadCompactionInput
) => Promise<boolean>;

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
  transformModelContext,
}: {
  readonly history: readonly ModelMessage[];
  readonly model: ModelGenerationOptions;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<string> {
  const signal = new AbortController().signal;
  const summaryHistory: readonly ModelMessage[] = [
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

function summaryHistoryForRange({
  compactions,
  history,
  range,
  state,
}: {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
  readonly range: AutoCompactionRange;
  readonly state: ThreadState;
}): ModelMessage[] {
  const prefixHistory = history.slice(range.startSeq, range.endSeqExclusive);
  if (range.startSeq !== 0) {
    return state.projectModelContext(
      { compactions: [], history: prefixHistory },
      prefixHistory
    );
  }

  const prefixCompactions = compactions.filter(
    (record) => record.endSeqExclusive <= range.endSeqExclusive
  );
  const modelContext = new ModelMessageHistory(
    prefixHistory,
    undefined,
    prefixCompactions
  ).modelContextSnapshot();
  return state.projectModelContext(
    { compactions: prefixCompactions, history: prefixHistory },
    modelContext
  );
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
