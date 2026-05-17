export type UserText = { type: "user-text"; text: string };
export type AssistantText = { type: "assistant-text"; text: string };
export type ToolCall = { type: "tool-call"; toolName: string };

export type ModelHistoryItem = UserText | AssistantText | ToolCall;

export type AgentLifecycleEvent =
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
  /** One model/tool-loop iteration finished within the active turn. */
  | { type: "step-end" };

export type AgentEvent = ModelHistoryItem | AgentLifecycleEvent;

export type AgentEventListener = (event: AgentEvent) => void;
