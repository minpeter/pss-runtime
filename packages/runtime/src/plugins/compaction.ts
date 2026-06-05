import type { ModelMessage } from "ai";
import type { AgentCompactionOverlay } from "../session/snapshot";
import { getActiveAgentPluginScope } from "./scope";
import { definePlugin } from "./types";

export type CompactionSummarizer = (context: {
  readonly messages: readonly ModelMessage[];
}) => Promise<string> | string;

export interface CompactionOptions {
  readonly summarize?: CompactionSummarizer;
  readonly thresholdMessages?: number;
}

const DEFAULT_THRESHOLD_MESSAGES = 40;
const MIN_MESSAGES_TO_COMPACT = 8;
const TAIL_MESSAGES_TO_KEEP = 4;

export function compaction(options: CompactionOptions = {}) {
  return definePlugin({
    name: "compaction",
    setup(host) {
      host.transformContext(({ history }) =>
        applyCompactionOverlays(
          history,
          getActiveAgentPluginScope()?.getCompactions() ?? []
        )
      );
      host.on("turn.after", async ({ history }) => {
        await maybeCompact(history, options);
      });
    },
  });
}

export function applyCompactionOverlays(
  history: readonly ModelMessage[],
  overlays: readonly AgentCompactionOverlay[]
): ModelMessage[] {
  const selected = selectValidOverlays(history, overlays);
  if (selected.length === 0) {
    return structuredClone([...history]);
  }

  const output: ModelMessage[] = [];
  let index = 0;
  while (index < history.length) {
    const overlay = selected.find(
      (candidate) => candidate.startIndex === index
    );
    if (overlay) {
      output.push(compactionSummaryMessage(overlay));
      index = overlay.endIndex + 1;
      continue;
    }

    const message = history[index];
    if (message) {
      output.push(structuredClone(message));
    }
    index += 1;
  }

  return output;
}

async function maybeCompact(
  history: readonly ModelMessage[],
  options: CompactionOptions
): Promise<void> {
  const scope = getActiveAgentPluginScope();
  if (!scope) {
    return;
  }

  const threshold = options.thresholdMessages ?? DEFAULT_THRESHOLD_MESSAGES;
  if (history.length < threshold || history.length < MIN_MESSAGES_TO_COMPACT) {
    return;
  }

  const endIndex = history.length - TAIL_MESSAGES_TO_KEEP - 1;
  if (endIndex < 0) {
    return;
  }

  const existing = scope.getCompactions();
  const nextRange = { endIndex, startIndex: 0 };
  const existingLeadingOverlay = existing.find(
    (overlay) => overlay.startIndex === nextRange.startIndex
  );
  if (existingLeadingOverlay && existingLeadingOverlay.endIndex >= endIndex) {
    return;
  }
  if (
    existing.some(
      (overlay) =>
        overlay.startIndex !== nextRange.startIndex &&
        rangesOverlap(overlay, nextRange)
    )
  ) {
    return;
  }

  try {
    const messages = history.slice(0, endIndex + 1);
    const summary = options.summarize
      ? await options.summarize({ messages })
      : await scope.summarize(messages);
    const nextOverlay = {
      createdAt: new Date().toISOString(),
      endIndex,
      id: existingLeadingOverlay?.id ?? `compaction-${existing.length + 1}`,
      startIndex: 0,
      summary,
    };
    scope.setCompactions([
      ...existing.filter(
        (overlay) => overlay.startIndex !== nextRange.startIndex
      ),
      nextOverlay,
    ]);
  } catch {
    return;
  }
}

function selectValidOverlays(
  history: readonly ModelMessage[],
  overlays: readonly AgentCompactionOverlay[]
): AgentCompactionOverlay[] {
  const selected: AgentCompactionOverlay[] = [];
  for (const overlay of overlays) {
    if (!isValidOverlay(history, overlay)) {
      continue;
    }

    const sameStartIndex = selected.findIndex(
      (existing) => existing.startIndex === overlay.startIndex
    );
    if (sameStartIndex >= 0) {
      selected[sameStartIndex] = overlay;
      continue;
    }

    if (selected.some((existing) => rangesOverlap(existing, overlay))) {
      continue;
    }

    selected.push(overlay);
  }

  return selected.sort((left, right) => left.startIndex - right.startIndex);
}

function isValidOverlay(
  history: readonly ModelMessage[],
  overlay: AgentCompactionOverlay
): boolean {
  return (
    Number.isInteger(overlay.startIndex) &&
    Number.isInteger(overlay.endIndex) &&
    overlay.startIndex >= 0 &&
    overlay.endIndex >= overlay.startIndex &&
    overlay.endIndex < history.length
  );
}

function rangesOverlap(
  left: { readonly endIndex: number; readonly startIndex: number },
  right: { readonly endIndex: number; readonly startIndex: number }
): boolean {
  return left.startIndex <= right.endIndex && right.startIndex <= left.endIndex;
}

function compactionSummaryMessage(
  overlay: AgentCompactionOverlay
): ModelMessage {
  return assistantMessage(
    `Compaction summary ${overlay.id}: ${overlay.summary}`
  );
}

function assistantMessage(content: string): ModelMessage {
  return { content, role: "assistant" };
}
