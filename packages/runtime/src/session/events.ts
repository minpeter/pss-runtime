import type { UserInput, UserMessage, UserText } from "./input";

export type {
  UserInput,
  UserMessage,
  UserMessageContent,
  UserMessageContentPart,
  UserMessageFileData,
  UserMessageFilePart,
  UserMessageImagePart,
  UserMessageTextPart,
  UserText,
  UserTextContent,
} from "./input";

export interface RuntimeInput {
  /**
   * Runtime/API-originated model input inserted into the current turn.
   * This is distinct from human-originated user-text and user-message input.
   */
  input: UserInput;
  placement: "turn-start" | "step-start" | "step-end";
  type: "runtime-input";
}

export type OverlayPlacement =
  | "idle"
  | "step-end"
  | "step-start"
  | "turn-start";

export interface OverlayInputSummary {
  partCount?: number;
  preview: string;
  textLength?: number;
  type: UserInput["type"];
}

export interface OverlayAccepted {
  input: OverlayInputSummary;
  placement: OverlayPlacement;
  type: "overlay-accepted";
}

export interface OverlayExpired {
  count: number;
  reason: "kill" | "turn-abort" | "turn-end" | "turn-error";
  type: "overlay-expired";
}

export interface AssistantText {
  text: string;
  type: "assistant-text";
}
export interface AssistantReasoning {
  text: string;
  type: "assistant-reasoning";
}
export interface ToolCall {
  input: unknown;
  toolCallId: string;
  toolName: string;
  type: "tool-call";
}
export interface ToolResult {
  output: unknown;
  toolCallId: string;
  toolName: string;
  type: "tool-result";
}

export type AgentEvent =
  /** User input was accepted into the session queue. */
  | UserText
  /** User multipart input was accepted into the session queue. */
  | UserMessage
  /** Runtime/API-originated input inserted into the current turn, not human input. */
  | RuntimeInput
  | OverlayAccepted
  | OverlayExpired
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
  /** The model produced reasoning content. */
  | AssistantReasoning
  /** The model produced visible assistant text. */
  | AssistantText
  /** The model requested a tool call. */
  | ToolCall
  /** A tool call returned a result. */
  | ToolResult
  /** One model/tool-loop iteration finished within the active turn. */
  | { type: "step-end" };

export type AgentEventListener = (event: AgentEvent) => void;
