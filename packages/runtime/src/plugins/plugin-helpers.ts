import type { ModelMessage } from "ai";
import type { ModelStepOutput } from "../llm/model-step-types";
import type { AgentEvent, ToolResult } from "../thread/protocol/events";
import {
  isCompactionContextMessage,
  type ThreadContextMessage,
} from "../thread/state/context";
import type { ThreadCompactionInput } from "../thread/state/thread-state";
import type {
  InputAcceptEvent,
  ProviderCallOptions,
  Subscription,
} from "./api";

export function assertInputAcceptEvent(
  value: unknown
): asserts value is InputAcceptEvent {
  if (
    !(value && typeof value === "object" && "type" in value) ||
    (value.type !== "runtime-input" && value.type !== "user-input")
  ) {
    throw new TypeError(
      "Plugin input.accept transform must return a user-input or runtime-input event."
    );
  }
}

export function assertTurnStartEvent(
  value: unknown
): asserts value is Extract<AgentEvent, { type: "turn-start" }> {
  if (!(value && typeof value === "object" && "type" in value)) {
    throw new TypeError(
      "Plugin turn.start.before transform must return a turn-start event."
    );
  }
  if (value.type !== "turn-start") {
    throw new TypeError(
      "Plugin turn.start.before transform must return a turn-start event."
    );
  }
}

export function assertToolResultEvent(
  value: unknown
): asserts value is ToolResult {
  if (
    !(
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "tool-result" &&
      "toolCallId" in value &&
      typeof value.toolCallId === "string" &&
      "toolName" in value &&
      typeof value.toolName === "string" &&
      "output" in value
    )
  ) {
    throw new TypeError(
      "Plugin tool.result transform must return a complete tool-result event."
    );
  }
}

export function assertModelContextEvent(
  value: unknown
): asserts value is { readonly messages: readonly ThreadContextMessage[] } {
  const message =
    "Plugin model.context transform must return a messages array.";
  if (!(value && typeof value === "object" && "messages" in value)) {
    throw new TypeError(message);
  }
  if (
    !(
      Array.isArray(value.messages) &&
      value.messages.every(
        (item) => isModelMessage(item) || isCompactionContextMessage(item)
      )
    )
  ) {
    throw new TypeError(message);
  }
}

export function assertModelStep(
  value: unknown,
  message: string
): asserts value is { readonly messages: ModelStepOutput } {
  if (!(value && typeof value === "object" && "messages" in value)) {
    throw new TypeError(message);
  }
  if (
    !(
      Array.isArray(value.messages) &&
      value.messages.every(
        (item) =>
          isModelMessage(item) &&
          (item.role === "assistant" || item.role === "tool")
      )
    )
  ) {
    throw new TypeError(message);
  }
}

function isModelMessage(value: unknown): value is ModelMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "role" in value &&
      (value.role === "system" ||
        value.role === "user" ||
        value.role === "assistant" ||
        value.role === "tool") &&
      "content" in value
  );
}

export function assertProviderBeforeRequestEvent(
  value: unknown
): asserts value is { readonly params: ProviderCallOptions } {
  if (
    !(
      value &&
      typeof value === "object" &&
      "params" in value &&
      value.params &&
      typeof value.params === "object"
    )
  ) {
    throw new TypeError(
      "Plugin provider.request.before transform must return provider params."
    );
  }
}

export function assertCompactionInput(
  value: unknown
): asserts value is ThreadCompactionInput {
  if (
    !(
      value &&
      typeof value === "object" &&
      "startSeq" in value &&
      typeof value.startSeq === "number" &&
      "endSeqExclusive" in value &&
      typeof value.endSeqExclusive === "number" &&
      "summary" in value &&
      typeof value.summary === "string"
    )
  ) {
    throw new TypeError(
      "Plugin thread.compaction.before transform must return a compaction input."
    );
  }
}

export function cloneEvent<T>(event: T): T {
  try {
    return structuredClone(event);
  } catch {
    return event;
  }
}

export function cloneToolCallInput(input: unknown): unknown {
  try {
    return structuredClone(input);
  } catch (cause) {
    throw new TypeError(
      "Plugin tool.call.before transform input must be structured-cloneable.",
      { cause }
    );
  }
}

export function subscriptionFor(dispose: () => void): Subscription {
  let active = true;
  return {
    unsubscribe: () => {
      if (!active) {
        return;
      }
      active = false;
      dispose();
    },
  };
}
