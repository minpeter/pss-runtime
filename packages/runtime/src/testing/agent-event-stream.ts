import type { AgentEvent } from "../thread/protocol/events";

/**
 * Replays a fixed list of events as an async iterable, in order. Useful for
 * building deterministic `AgentTurn.events()` sequences in tests.
 */
export async function* agentEventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
