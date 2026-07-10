import {
  type AgentEvent,
  type AgentEventContext,
  type AgentPlugin,
  isLifecycleAgentEvent,
  isToolAgentEvent,
} from "@minpeter/pss-runtime";

export interface TurnObservabilityEntry {
  readonly event: AgentEvent["type"];
  readonly label?: string;
  readonly message?: string;
  readonly toolName?: string;
}

export interface TurnObservabilityOptions {
  readonly label?: string;
  /** Defaults to a no-op collector — prefer folding into the request wide event. */
  readonly log?: (entry: TurnObservabilityEntry) => void;
}

export interface ToolpickSelectionSummary {
  readonly activeTools: readonly string[];
  readonly reason: string;
  readonly stepNumber: number;
}

export interface TurnObservabilitySummary {
  readonly errors: readonly string[];
  readonly steps: number;
  readonly toolCalls: readonly string[];
  readonly toolpick?: readonly ToolpickSelectionSummary[];
}

/** Accumulate lifecycle/tool events for one wide event instead of N log lines. */
export function createTurnEventCollector(): {
  readonly record: (entry: TurnObservabilityEntry) => void;
  readonly recordToolpick: (selection: ToolpickSelectionSummary) => void;
  readonly summary: () => TurnObservabilitySummary;
} {
  const toolCalls: string[] = [];
  const errors: string[] = [];
  const toolpick: ToolpickSelectionSummary[] = [];
  let steps = 0;

  return {
    record(entry) {
      if (entry.event === "step-start") {
        steps += 1;
      }
      if (entry.event === "tool-call" && entry.toolName) {
        toolCalls.push(entry.toolName);
      }
      if (entry.event === "turn-error" && entry.message) {
        errors.push(entry.message);
      }
    },
    recordToolpick(selection) {
      toolpick.push({
        activeTools: [...selection.activeTools],
        reason: selection.reason,
        stepNumber: selection.stepNumber,
      });
    },
    summary() {
      return {
        errors: [...errors],
        steps,
        toolCalls: [...toolCalls],
        ...(toolpick.length > 0 ? { toolpick: [...toolpick] } : {}),
      };
    },
  };
}

export function describeEvent(
  event: AgentEvent,
  label?: string
): TurnObservabilityEntry | undefined {
  if (isToolAgentEvent(event)) {
    return { event: event.type, label, toolName: event.toolName };
  }

  if (isLifecycleAgentEvent(event)) {
    return event.type === "turn-error"
      ? { event: event.type, label, message: event.message }
      : { event: event.type, label };
  }

  return;
}

export function createTurnObservabilityPlugin(
  options: TurnObservabilityOptions = {}
): AgentPlugin {
  const record = options.log ?? (() => undefined);

  return {
    name: "worker-agent.turn-observability",
    on(context: AgentEventContext) {
      // Only lifecycle/tool events are surfaced; user-authored text events are
      // intentionally never logged so this hook cannot leak conversation content.
      const entry = describeEvent(context.event, options.label);
      if (entry) {
        record(entry);
      }
      return;
    },
  };
}
