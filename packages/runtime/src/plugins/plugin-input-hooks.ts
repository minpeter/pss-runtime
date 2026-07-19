import type { ModelMessage } from "ai";
import type { AgentEvent, ToolResult } from "../thread/protocol/events";
import type {
  InputAcceptEvent,
  PluginRequestResultMap,
  PluginToolCallBeforeEvent,
} from "./api";
import { cloneToolCallInput } from "./plugin-clone";
import {
  invokeHandler,
  notifyHandlers,
  throwHookFailure,
  validateRequestResult,
} from "./plugin-invocation";
import { activeHandlers } from "./plugin-registry";
import type {
  PluginInputDecision,
  PluginRuntimeState,
  PluginToolExecutionDecision,
} from "./plugin-types";

export async function interceptInput(
  state: PluginRuntimeState,
  threadKey: string,
  event: InputAcceptEvent,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<PluginInputDecision> {
  let current = structuredClone(event);
  for (const { registered, registration } of activeHandlers(
    state,
    "input.accept"
  )) {
    const result = await invokeHandler(
      state,
      registration,
      "input.accept",
      registered,
      structuredClone(current),
      { history, signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["input.accept"]
      | undefined;
    await validateRequestResult(state, registration, "input.accept", decision, [
      "continue",
      "handled",
      "transform",
    ]);
    if (decision?.action === "handled") {
      return "handled";
    }
    if (decision?.action === "transform") {
      try {
        assertInputAcceptEvent(decision.value);
      } catch (cause) {
        await throwHookFailure(state, registration, "input.accept", cause);
      }
      current = structuredClone(decision.value);
    }
  }
  return current;
}

export async function beforeTurnStart(
  state: PluginRuntimeState,
  threadKey: string,
  event: Extract<AgentEvent, { type: "turn-start" }>,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<Extract<AgentEvent, { type: "turn-start" }>> {
  let current = structuredClone(event);
  for (const { registered, registration } of activeHandlers(
    state,
    "turn.start.before"
  )) {
    const result = await invokeHandler(
      state,
      registration,
      "turn.start.before",
      registered,
      structuredClone(current),
      { history, signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["turn.start.before"]
      | undefined;
    await validateRequestResult(
      state,
      registration,
      "turn.start.before",
      decision,
      ["continue", "transform"]
    );
    if (decision?.action === "transform") {
      try {
        assertTurnStartEvent(decision.value);
      } catch (cause) {
        await throwHookFailure(state, registration, "turn.start.before", cause);
      }
      current = structuredClone(decision.value);
    }
  }
  return current;
}

export async function beforeToolExecution(
  state: PluginRuntimeState,
  threadKey: string,
  event: PluginToolCallBeforeEvent,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<PluginToolExecutionDecision> {
  let currentInput = structuredClone(event.input);
  let inputTransformed = false;
  for (const { registered, registration } of activeHandlers(
    state,
    "tool.call.before"
  )) {
    const snapshot: PluginToolCallBeforeEvent = {
      ...event,
      input: structuredClone(currentInput),
    };
    const result = await invokeHandler(
      state,
      registration,
      "tool.call.before",
      registered,
      snapshot,
      { history, signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["tool.call.before"]
      | undefined;
    await validateRequestResult(
      state,
      registration,
      "tool.call.before",
      decision,
      ["block", "continue", "needs-recovery", "transform"]
    );
    if (decision?.action === "needs-recovery") {
      return { status: "needs-recovery" };
    }
    if (decision?.action === "block") {
      return {
        output: {
          blocked: true,
          reason: decision.reason ?? "Tool call blocked by plugin.",
        },
        status: "blocked",
      };
    }
    if (decision?.action === "transform") {
      try {
        currentInput = cloneToolCallInput(decision.input);
      } catch (cause) {
        await throwHookFailure(state, registration, "tool.call.before", cause);
      }
      inputTransformed = true;
    }
  }

  const finalEvent: PluginToolCallBeforeEvent = {
    ...event,
    input: structuredClone(currentInput),
  };
  await notifyHandlers(state, "tool.execution.start", finalEvent, {
    history,
    signal,
    threadKey,
  });
  if (inputTransformed) {
    return { input: currentInput, status: "continue" };
  }
  return;
}

export async function afterToolExecution(
  state: PluginRuntimeState,
  threadKey: string,
  event: ToolResult,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<ToolResult> {
  let current = structuredClone(event);
  for (const { registered, registration } of activeHandlers(
    state,
    "tool.result"
  )) {
    const result = await invokeHandler(
      state,
      registration,
      "tool.result",
      registered,
      structuredClone(current),
      { history, signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["tool.result"]
      | undefined;
    await validateRequestResult(state, registration, "tool.result", decision, [
      "continue",
      "transform",
    ]);
    if (decision?.action === "transform") {
      try {
        assertToolResultEvent(decision.value);
      } catch (cause) {
        await throwHookFailure(state, registration, "tool.result", cause);
      }
      current = structuredClone(decision.value);
    }
  }

  await notifyHandlers(state, "tool.execution.end", current, {
    history,
    signal,
    threadKey,
  });
  return current;
}

function assertInputAcceptEvent(
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

function assertTurnStartEvent(
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

function assertToolResultEvent(value: unknown): asserts value is ToolResult {
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
