export type AgentEvent =
  /** User input was accepted into the session queue. */
  | { type: "user-text"; text: string }
  /** A queued user input started running as a turn. */
  | { type: "turn-start" }
  /** The active turn was interrupted before normal completion. */
  | { type: "turn-abort" }
  /** The active turn hit an unrecoverable runtime failure. */
  | { type: "turn-error"; message: string }
  /** The active turn completed normally. */
  | { type: "turn-end" }
  /** One model/tool-loop iteration started within the active turn. */
  | { type: "step-start" }
  /** The model produced visible assistant text. */
  | { type: "assistant-text"; text: string }
  /** The model requested a tool call. */
  | { type: "tool-call"; toolName: string }
  /** One model/tool-loop iteration finished within the active turn. */
  | { type: "step-end" };

export type AgentEventListener = (event: AgentEvent) => void;
