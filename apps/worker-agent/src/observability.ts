import {
  type AgentEvent,
  definePlugin,
  isLifecycleAgentEvent,
  isToolAgentEvent,
  type PluginDefinition,
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

export interface TurnObservabilitySummary {
  readonly errors: readonly string[];
  readonly steps: number;
  readonly toolCalls: readonly string[];
}

/** Accumulate lifecycle/tool events for one wide event instead of N log lines. */
export function createTurnEventCollector(): {
  readonly record: (entry: TurnObservabilityEntry) => void;
  readonly summary: () => TurnObservabilitySummary;
} {
  const toolCalls: string[] = [];
  const errors: string[] = [];
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
    summary() {
      return {
        errors: [...errors],
        steps,
        toolCalls: [...toolCalls],
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
): PluginDefinition {
  const record = options.log ?? (() => undefined);

  return definePlugin((pss) => {
    for (const eventName of [
      "step.start",
      "step.end",
      "turn.start",
      "turn.abort",
      "turn.end",
      "turn.error",
    ] as const) {
      pss.on(eventName, (event) => {
        // Only lifecycle/tool events are surfaced; user-authored text events are
        // intentionally never logged so this hook cannot leak conversation content.
        const entry = describeEvent(event, options.label);
        if (entry) {
          record(entry);
        }
      });
    }
    pss.on("tool.call.before", (event) => {
      record({
        event: "tool-call",
        label: options.label,
        toolName: event.toolName,
      });
      return { action: "continue" };
    });
    pss.on("tool.execution.end", (event) => {
      const entry = describeEvent(event, options.label);
      if (entry) {
        record(entry);
      }
    });
  });
}
