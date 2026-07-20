import type { ModelMessage } from "ai";

import type { ToolResult } from "../thread/protocol/events";
import type { PluginRequestResultMap, PluginToolCallBeforeEvent } from "./api";
import { cloneToolCallInput } from "./plugin-clone";
import { assertToolResultEvent } from "./plugin-input-hooks-asserts";
import {
  invokeHandler,
  notifyHandlers,
  throwHookFailure,
  validateRequestResult,
} from "./plugin-invocation";
import { activeHandlers } from "./plugin-registry";
import type {
  PluginRegistration,
  PluginRuntimeState,
  PluginToolExecutionDecision,
} from "./plugin-types";

type ToolCallBeforeDecision =
  | PluginRequestResultMap["tool.call.before"]
  | undefined;

type ToolCallBeforeStep =
  | { readonly kind: "final"; readonly decision: PluginToolExecutionDecision }
  | { readonly kind: "transformed"; readonly input: unknown }
  | { readonly kind: "unchanged" };

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
    const step = await applyToolCallBeforeDecision(
      state,
      registration,
      result as ToolCallBeforeDecision
    );
    if (step.kind === "final") {
      return step.decision;
    }
    if (step.kind === "transformed") {
      currentInput = step.input;
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

async function applyToolCallBeforeDecision(
  state: PluginRuntimeState,
  registration: PluginRegistration,
  decision: ToolCallBeforeDecision
): Promise<ToolCallBeforeStep> {
  await validateRequestResult(
    state,
    registration,
    "tool.call.before",
    decision,
    ["block", "continue", "needs-recovery", "transform"]
  );
  if (decision?.action === "needs-recovery") {
    return { decision: { status: "needs-recovery" }, kind: "final" };
  }
  if (decision?.action === "block") {
    return {
      decision: {
        output: {
          blocked: true,
          reason: decision.reason ?? "Tool call blocked by plugin.",
        },
        status: "blocked",
      },
      kind: "final",
    };
  }
  if (decision?.action === "transform") {
    try {
      return { input: cloneToolCallInput(decision.input), kind: "transformed" };
    } catch (cause) {
      await throwHookFailure(state, registration, "tool.call.before", cause);
    }
  }
  return { kind: "unchanged" };
}
