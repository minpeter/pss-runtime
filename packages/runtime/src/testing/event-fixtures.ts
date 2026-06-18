import type { AgentEvent } from "../thread/protocol/events";

export const eventTypes = (events: AgentEvent[]) =>
  events.map((event) => event.type);
