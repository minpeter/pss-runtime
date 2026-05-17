export interface UserText {
  text: string;
  type: "user-text";
}
export interface AssistantText {
  text: string;
  type: "assistant-text";
}
export interface ToolCall {
  toolName: string;
  type: "tool-call";
}

export type AgentEvent =
  /** User input was accepted into the session queue. */
  | UserText
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
  | AssistantText
  /** The model requested a tool call. */
  | ToolCall
  /** One model/tool-loop iteration finished within the active turn. */
  | { type: "step-end" };

export type AgentEventListener = (event: AgentEvent) => void;
