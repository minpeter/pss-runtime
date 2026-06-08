import type { AgentEvent } from "@minpeter/pss-runtime";
import { appBudgets, parseTurnBody } from "../request/schema";
import type { RunStressScenarioOptions } from ".";
import { type StressScenarioResult, scenarioResult } from "./result";

export function guardScenario(
  options: RunStressScenarioOptions
): StressScenarioResult {
  const scenario = options.request.scenario;
  const stress = options.request.stress;
  if (scenario === "request-rejection") {
    const rejected = parseTurnBody({});
    return scenarioResult(
      scenario,
      [],
      [
        `scenario:${scenario}`,
        rejected.ok
          ? "request:accepted"
          : `request:rejected:${rejected.status}`,
      ],
      undefined,
      stress.summaryEvents
    );
  }

  if (scenario === "fanout-guard") {
    return scenarioResult(
      scenario,
      assistantEvents("fanout", stress.fanout),
      [
        `scenario:${scenario}`,
        `fanout:${stress.fanout}`,
        `fanout:${stress.fanout}/${appBudgets.maxFanout}`,
        `history:${stress.historyItems}/${appBudgets.maxHistoryItems}`,
      ],
      undefined,
      stress.summaryEvents
    );
  }

  if (scenario === "large-history-guard") {
    return scenarioResult(
      scenario,
      assistantEvents("history", stress.historyItems),
      [
        `scenario:${scenario}`,
        `history-items:${stress.historyItems}`,
        `history:${stress.historyItems}/${appBudgets.maxHistoryItems}`,
        `summary-events:${stress.summaryEvents}`,
      ],
      undefined,
      stress.summaryEvents
    );
  }

  if (scenario === "checkpoint-size-guard") {
    const checkpointBytes = encodedBytes("x".repeat(stress.checkpointBytes));
    return scenarioResult(
      scenario,
      [],
      [
        `scenario:${scenario}`,
        `checkpoint-bytes:${checkpointBytes}`,
        `checkpoint-bytes:${checkpointBytes}/${appBudgets.maxCheckpointBytes}`,
      ],
      undefined,
      stress.summaryEvents
    );
  }

  return scenarioResult(
    scenario,
    assistantEvents("budget", stress.summaryEvents),
    [
      `scenario:${scenario}`,
      `summary-events:${stress.summaryEvents}`,
      `max-response-bytes:${appBudgets.maxSummaryBytes}`,
    ],
    undefined,
    stress.summaryEvents
  );
}

function assistantEvents(prefix: string, count: number): AgentEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `${prefix}:${index + 1}`,
    type: "assistant-text",
  }));
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
