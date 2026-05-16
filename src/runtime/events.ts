export type AgentEvent =
  | { type: "user-message"; text: string }
  | { type: "turn-start" }
  | { type: "turn-abort" }
  | { type: "turn-end" }
  | { type: "step-start" }
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string }
  | { type: "step-end" };

export type AgentEventListener = (event: AgentEvent) => void;
