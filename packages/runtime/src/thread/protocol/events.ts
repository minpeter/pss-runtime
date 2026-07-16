import type { UserInput, UserMessage, UserText } from "../input/input";
import type { InputEventMeta } from "../input/input-meta-types";

export type {
  UserInput,
  UserMessage,
  UserMessageContent,
  UserMessageContentPart,
  UserMessageFileData,
  UserMessageFilePart,
  UserMessageTextPart,
  UserText,
  UserTextContent,
} from "../input/input";
export type { InputEventMeta, InputSource } from "../input/input-meta-types";

export interface RuntimeInput {
  /**
   * Runtime/API-originated model input inserted into the current turn.
   * This is distinct from human-originated user-input.
   */
  input: UserInput;
  meta?: InputEventMeta;
  placement: "turn-start" | "step-start" | "step-end";
  type: "runtime-input";
}

export interface AssistantOutput {
  text: string;
  type: "assistant-output";
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
  /** User input was accepted into the thread queue. */
  | UserText
  /** User multipart input was accepted into the thread queue. */
  | UserMessage
  /** Runtime/API-originated input inserted into the current turn, not human input. */
  | RuntimeInput
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
  | AssistantOutput
  /** The model requested a tool call. */
  | ToolCall
  /** A tool call returned a result. */
  | ToolResult
  /** One model/tool-loop iteration finished within the active turn. */
  | { type: "step-end" };

export type AgentEventListener = (event: AgentEvent) => void;

const visibleAgentEventTypes = {
  "assistant-output": true,
  "user-input": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

const lifecycleAgentEventTypes = {
  "step-end": true,
  "step-start": true,
  "turn-abort": true,
  "turn-end": true,
  "turn-error": true,
  "turn-start": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

const toolAgentEventTypes = {
  "tool-call": true,
  "tool-result": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

const telemetryAgentEventTypes = {
  "assistant-reasoning": true,
  "runtime-input": true,
} satisfies Partial<Record<AgentEvent["type"], true>>;

export type VisibleAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof visibleAgentEventTypes }
>;
export type LifecycleAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof lifecycleAgentEventTypes }
>;
export type ToolAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof toolAgentEventTypes }
>;
export type TelemetryAgentEvent = Extract<
  AgentEvent,
  { type: keyof typeof telemetryAgentEventTypes }
>;
export type ControlAgentEvent = Exclude<AgentEvent, VisibleAgentEvent>;

export function isVisibleAgentEvent(
  event: AgentEvent
): event is VisibleAgentEvent {
  return event.type in visibleAgentEventTypes;
}

export function isLifecycleAgentEvent(
  event: AgentEvent
): event is LifecycleAgentEvent {
  return event.type in lifecycleAgentEventTypes;
}

export function isToolAgentEvent(event: AgentEvent): event is ToolAgentEvent {
  return event.type in toolAgentEventTypes;
}

export function isTelemetryAgentEvent(
  event: AgentEvent
): event is TelemetryAgentEvent {
  return event.type in telemetryAgentEventTypes;
}

export function isControlAgentEvent(
  event: AgentEvent
): event is ControlAgentEvent {
  return !isVisibleAgentEvent(event);
}
