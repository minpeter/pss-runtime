export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message"; text: string }
  | { type: "tool_call"; toolName: string }
  | { type: "turn_end" }
  | { type: "agent_end" };

export type AgentEventListener = (event: AgentEvent) => void;
