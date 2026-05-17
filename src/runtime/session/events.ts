import type {
  AssistantContent,
  AssistantModelMessage,
  ToolContent,
  ToolModelMessage,
  UserContent,
  UserModelMessage,
} from "ai";

export type AssistantContentPart = Exclude<AssistantContent, string>[number];
export type UserContentPart = Exclude<UserContent, string>[number];
export type ToolContentPart = ToolContent[number];

export type UserMessage = UserModelMessage;
export type AssistantMessage = AssistantModelMessage;
export type ToolMessage = ToolModelMessage;

export type ModelHistoryItem = UserMessage | AssistantMessage | ToolMessage;

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
