import type { AssistantContent, UserContent } from "ai";

type ArrayItem<T> = T extends Array<infer Item> ? Item : never;
type AssistantContentPart = ArrayItem<Exclude<AssistantContent, string>>;
type UserContentPart = ArrayItem<Exclude<UserContent, string>>;
type RuntimeTextPart<TType extends string> = Omit<
  Extract<AssistantContentPart | UserContentPart, { type: "text" }>,
  "type"
> & {
  type: TType;
};

export type UserText = RuntimeTextPart<"user-text">;
export type AssistantText = RuntimeTextPart<"assistant-text">;
export type ToolCall = Extract<AssistantContentPart, { type: "tool-call" }>;

export type ModelHistoryItem = UserText | AssistantText | ToolCall;

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
