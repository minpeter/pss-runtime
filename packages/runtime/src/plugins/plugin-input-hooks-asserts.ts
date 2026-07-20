import type { AgentEvent, ToolResult } from "../thread/protocol/events";
import type { InputAcceptEvent } from "./api";

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
