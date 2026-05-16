export type AgentEvent =
  | { type: "agent-start" }
  | { type: "turn-start" }
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string }
  | { type: "turn-end" }
  | { type: "agent-end" };

export type AgentEventListener = (event: AgentEvent) => void;
