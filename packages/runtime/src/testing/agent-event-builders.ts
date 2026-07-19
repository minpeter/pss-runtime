import type {
  AgentEvent,
  AssistantOutput,
  AssistantReasoning,
  ToolCall,
  ToolResult,
} from "../thread/protocol/events";
import { userMessage, userText } from "./input-fixtures";

type LifecycleEvent<Type extends AgentEvent["type"]> = Extract<
  AgentEvent,
  { type: Type }
>;

const assistantOutput = (text: string): AssistantOutput => ({
  text,
  type: "assistant-output",
});

const assistantReasoning = (text: string): AssistantReasoning => ({
  text,
  type: "assistant-reasoning",
});

const toolCall = (
  toolName: string,
  input: unknown = {},
  toolCallId = `${toolName}-call`
): ToolCall => ({
  input,
  toolCallId,
  toolName,
  type: "tool-call",
});

const toolResult = (
  toolName: string,
  output: unknown = {},
  toolCallId = `${toolName}-call`
): ToolResult => ({
  output,
  toolCallId,
  toolName,
  type: "tool-result",
});

const stepStart = (): LifecycleEvent<"step-start"> => ({ type: "step-start" });

const stepEnd = (): LifecycleEvent<"step-end"> => ({ type: "step-end" });

const turnStart = (): LifecycleEvent<"turn-start"> => ({ type: "turn-start" });

const turnEnd = (): LifecycleEvent<"turn-end"> => ({ type: "turn-end" });

const turnAbort = (): LifecycleEvent<"turn-abort"> => ({ type: "turn-abort" });

const turnError = (message: string): LifecycleEvent<"turn-error"> => ({
  message,
  type: "turn-error",
});

/**
 * Typed builders for public `AgentEvent` payloads. Builders stay in sync with
 * the runtime event union, so downstream mocks do not drift when event names
 * or shapes change.
 */
export const agentEvent = {
  assistantOutput,
  assistantReasoning,
  stepEnd,
  stepStart,
  toolCall,
  toolResult,
  turnAbort,
  turnEnd,
  turnError,
  turnStart,
  userMessage,
  userText,
} as const;
