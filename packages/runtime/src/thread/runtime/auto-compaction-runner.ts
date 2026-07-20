import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { ThreadState } from "../state/thread-state";
import { selectAutoCompactionRange } from "./auto-compaction-range";
import {
  summarizeCompactionRange,
  summaryHistoryForRange,
} from "./auto-compaction-summary";
import type {
  AutoCompactionRange,
  ThreadAutoCompactionOptions,
  ThreadCompactionHandler,
  ThreadModelContextTransform,
} from "./auto-compaction-types";

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
      history: summaryHistoryForRange({ compactions, history, range }),
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
