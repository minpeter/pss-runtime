import type { ModelMessage } from "ai";

import type { AgentEvent } from "../thread/protocol/events";
import type { InputAcceptEvent, PluginRequestResultMap } from "./api";
import {
  assertInputAcceptEvent,
  assertTurnStartEvent,
} from "./plugin-input-hooks-asserts";
import {
  invokeHandler,
  throwHookFailure,
  validateRequestResult,
} from "./plugin-invocation";
import { activeHandlers } from "./plugin-registry";
import type { PluginInputDecision, PluginRuntimeState } from "./plugin-types";

// biome-ignore lint/performance/noBarrelFile: plugin-runtime and tests import all four hook runners from this module; the tool-call pair lives in plugin-input-hooks-tool-call.ts after the split.
export {
  afterToolExecution,
  beforeToolExecution,
} from "./plugin-input-hooks-tool-call";

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
