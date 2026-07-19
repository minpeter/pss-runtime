import type { AgentEvent } from "../thread/protocol/events";
import type { AgentTurn } from "../thread/protocol/turn";
import { agentEventStream } from "./agent-event-stream";

/**
 * Creates an `AgentTurn` that replays the given events. Like a real turn,
 * `events()` is single-consumption: calling it a second time throws.
 */
export function createMockAgentTurn(
  events: readonly AgentEvent[] | AsyncIterable<AgentEvent>
): AgentTurn {
  let eventsStarted = false;

  return {
    events(): AsyncIterable<AgentEvent> {
      if (eventsStarted) {
        throw new Error("AgentTurn.events() can only be consumed once");
      }
      eventsStarted = true;
      return isAsyncIterable(events) ? events : agentEventStream(events);
    },
  };
}

function isAsyncIterable(
  events: readonly AgentEvent[] | AsyncIterable<AgentEvent>
): events is AsyncIterable<AgentEvent> {
  return (
    typeof (events as AsyncIterable<AgentEvent>)[Symbol.asyncIterator] ===
    "function"
  );
}
