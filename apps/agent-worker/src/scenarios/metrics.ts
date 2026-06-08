import type { AgentEvent } from "@minpeter/pss-runtime";
import { appBudgets } from "../request/schema";

export interface EventSummary {
  readonly assistantText: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly eventCount: number;
  readonly eventTypes: readonly string[];
  readonly toolNames: readonly string[];
  readonly truncated: boolean;
}

export function summarizeEvents(
  events: readonly AgentEvent[],
  limit: number = appBudgets.maxSummaryEvents
): EventSummary {
  const selected = events.slice(0, limit);
  const counts: Record<string, number> = {};
  const assistantText: string[] = [];
  const toolNames: string[] = [];

  for (const event of selected) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    if (event.type === "assistant-text") {
      assistantText.push(event.text);
    }
    if (event.type === "tool-call") {
      toolNames.push(event.toolName);
    }
  }

  return {
    assistantText,
    counts,
    eventCount: selected.length,
    eventTypes: selected.map((event) => event.type),
    toolNames,
    truncated: events.length > selected.length,
  };
}
