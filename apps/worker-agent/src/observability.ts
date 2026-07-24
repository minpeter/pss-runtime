import {
  type AgentEvent,
  type AgentInstrumentation,
  isLifecycleAgentEvent,
  isToolAgentEvent,
} from "@minpeter/pss-runtime";

export interface TurnObservabilityEntry {
  readonly event: AgentEvent["type"];
  readonly label?: string;
  readonly message?: string;
  readonly toolName?: string;
}

interface TurnObservabilityOptions {
  readonly label?: string;
  /** Defaults to a no-op collector — prefer folding into the request wide event. */
  readonly log?: (entry: TurnObservabilityEntry) => void;
}

interface TurnObservabilitySummary {
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

export function createTurnObservabilityInstrumentation(
  options: TurnObservabilityOptions = {}
): AgentInstrumentation {
  const record = options.log ?? (() => undefined);

  return {
    wrapTurn(turn) {
      return {
        events() {
          return observeEvents(turn.events(), options.label, record);
        },
      };
    },
  };
}

async function* observeEvents(
  events: AsyncIterable<AgentEvent>,
  label: string | undefined,
  record: (entry: TurnObservabilityEntry) => void
): AsyncIterable<AgentEvent> {
  for await (const event of events) {
    const entry = describeEvent(event, label);
    if (entry) {
      record(entry);
    }
    yield event;
  }
}
