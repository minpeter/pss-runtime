import type { AgentEvent } from "@minpeter/pss-runtime";
import { appBudgets, type ScenarioId } from "./request-schema";
import type { EventSummary } from "./worker-metrics";
import { summarizeEvents } from "./worker-metrics";

export interface StressScenarioResult {
  readonly events: readonly AgentEvent[];
  readonly markers: readonly string[];
  readonly pluginCounts?: Readonly<Record<string, number>>;
  readonly scenario: ScenarioId;
  readonly summary: EventSummary;
}

export function scenarioResult(
  scenario: ScenarioId,
  events: readonly AgentEvent[],
  markers: readonly string[],
  pluginCounts?: Readonly<Record<string, number>>,
  summaryEvents: number = appBudgets.maxSummaryEvents
): StressScenarioResult {
  const eventLimit = Math.min(summaryEvents, appBudgets.maxSummaryEvents);
  const limitedEvents = limitEventsByBudget(events, eventLimit);
  return {
    events: limitedEvents,
    markers,
    pluginCounts,
    scenario,
    summary: summarizeEvents(events, limitedEvents.length),
  };
}

function limitEventsByBudget(
  events: readonly AgentEvent[],
  maxEvents: number
): AgentEvent[] {
  const selected: AgentEvent[] = [];
  let totalBytes = 2;
  for (const event of events.slice(0, maxEvents)) {
    const eventBytes = encodedBytes(JSON.stringify(event));
    const separatorBytes = selected.length > 0 ? 1 : 0;
    if (totalBytes + separatorBytes + eventBytes > appBudgets.maxSummaryBytes) {
      break;
    }
    selected.push(event);
    totalBytes += separatorBytes + eventBytes;
  }
  return selected;
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
