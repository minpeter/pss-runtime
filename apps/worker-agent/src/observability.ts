import {
  type AgentEvent,
  type AgentEventContext,
  type AgentPlugin,
  isLifecycleAgentEvent,
  isToolAgentEvent,
} from "@minpeter/pss-runtime";

import { logError, logInfo } from "./worker-log";

export interface TurnObservabilityEntry {
  readonly event: AgentEvent["type"];
  readonly label?: string;
  readonly message?: string;
  readonly toolName?: string;
}

export interface TurnObservabilityOptions {
  readonly label?: string;
  readonly log?: (entry: TurnObservabilityEntry) => void;
}

function defaultLog(entry: TurnObservabilityEntry): void {
  const event = {
    scope: "worker-agent.turn",
    event: entry.event,
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.message ? { message: entry.message } : {}),
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
  };
  if (entry.event === "turn-error") {
    logError(event);
    return;
  }
  logInfo(event);
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
  const log = options.log ?? defaultLog;

  return {
    name: "worker-agent.turn-observability",
    on(context: AgentEventContext) {
      // Only lifecycle/tool events are surfaced; user-authored text events are
      // intentionally never logged so this hook cannot leak conversation content.
      const entry = describeEvent(context.event, options.label);
      if (entry) {
        log(entry);
      }
      return;
    },
  };
}
