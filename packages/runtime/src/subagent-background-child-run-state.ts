import type { RunCheckpoint } from "./execution/types";
import type { AgentInput } from "./session/input";

export interface DurableBackgroundChildRunState {
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly groupId?: string;
  readonly kind: "background-subagent";
  readonly parentSessionKey?: string;
  readonly prompt: AgentInput;
  readonly subagent: string;
}

export function durableBackgroundChildRunState({
  delegateToolCallId,
  description,
  groupId,
  parentSessionKey,
  prompt,
  subagent,
}: {
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly groupId?: string;
  readonly parentSessionKey?: string;
  readonly prompt: AgentInput;
  readonly subagent?: string;
}): DurableBackgroundChildRunState {
  return {
    ...(delegateToolCallId ? { delegateToolCallId } : {}),
    ...(description ? { description } : {}),
    ...(groupId ? { groupId } : {}),
    kind: "background-subagent",
    ...(parentSessionKey ? { parentSessionKey } : {}),
    prompt: structuredClone(prompt),
    subagent: subagent ?? "subagent",
  };
}

export function readDurableBackgroundChildRunState(
  checkpoint: RunCheckpoint | null
): DurableBackgroundChildRunState | null {
  const state = checkpoint?.runtimeState;
  if (!isRecord(state) || state.kind !== "background-subagent") {
    return null;
  }

  if (!isAgentInput(state.prompt) || typeof state.subagent !== "string") {
    return null;
  }

  return {
    ...(typeof state.delegateToolCallId === "string"
      ? { delegateToolCallId: state.delegateToolCallId }
      : {}),
    ...(typeof state.description === "string"
      ? { description: state.description }
      : {}),
    ...(typeof state.groupId === "string" ? { groupId: state.groupId } : {}),
    kind: "background-subagent",
    ...(typeof state.parentSessionKey === "string"
      ? { parentSessionKey: state.parentSessionKey }
      : {}),
    prompt: state.prompt,
    subagent: state.subagent,
  };
}

function isAgentInput(value: unknown): value is AgentInput {
  return (
    typeof value === "string" ||
    isStringArray(value) ||
    isUserInput(value) ||
    isMessageContent(value)
  );
}

function isUserInput(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type === "user-text") {
    return typeof value.text === "string" || isStringArray(value.text);
  }

  return value.type === "user-message" && isMessageContent(value.content);
}

function isMessageContent(value: unknown): boolean {
  return Array.isArray(value) && value.every(isMessageContentPart);
}

function isMessageContentPart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  return (
    value.type === "text" || value.type === "image" || value.type === "file"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
