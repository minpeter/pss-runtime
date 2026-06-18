import type { AgentEvent } from "../session/protocol/events";

export const eventTypes = (events: AgentEvent[]) =>
  events.map((event) => event.type);
