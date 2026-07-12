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
      if (entry.event === "tool-result" && entry.message && entry.toolName) {
        errors.push(`${entry.toolName}: ${entry.message}`);
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
    const errorMessage =
      event.type === "tool-result"
        ? toolResultErrorMessage(event.output)
        : undefined;
    return {
      event: event.type,
      label,
      toolName: event.toolName,
      ...(errorMessage ? { message: errorMessage } : {}),
    };
  }

  if (isLifecycleAgentEvent(event)) {
    return event.type === "turn-error"
      ? { event: event.type, label, message: event.message }
      : { event: event.type, label };
  }

  return;
}

function toolResultErrorMessage(output: unknown): string | undefined {
  if (!output || typeof output !== "object") {
    return;
  }
  if (
    "type" in output &&
    (output.type === "error-text" || output.type === "error-json") &&
    "value" in output
  ) {
    const value = output.value;
    if (typeof value === "string" && value.trim()) {
      return value.slice(0, 300);
    }
    if (value !== undefined) {
      try {
        return JSON.stringify(value).slice(0, 300);
      } catch {
        return "tool error";
      }
    }
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
