import type { ModelMessage } from "ai";
import type { ModelStepOutput } from "../llm/model-step-types";
import {
  isCompactionContextMessage,
  type ThreadContextMessage,
} from "../thread/state/context";
import type { ThreadCompactionInput } from "../thread/state/thread-state";
import type { PluginRequestResultMap } from "./api";
import {
  invokeHandler,
  throwHookFailure,
  validateRequestResult,
} from "./plugin-invocation";
import { activeHandlers } from "./plugin-registry";
import type {
  PluginCompactionDecision,
  PluginRuntimeState,
} from "./plugin-types";

export async function beforeCompact(
  state: PluginRuntimeState,
  threadKey: string,
  input: ThreadCompactionInput,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<PluginCompactionDecision> {
  let current = structuredClone(input);
  for (const { registered, registration } of activeHandlers(
    state,
    "thread.compaction.before"
  )) {
    const result = await invokeHandler(
      state,
      registration,
      "thread.compaction.before",
      registered,
      { input: structuredClone(current) },
      { history, signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["thread.compaction.before"]
      | undefined;
    await validateRequestResult(
      state,
      registration,
      "thread.compaction.before",
      decision,
      ["cancel", "continue", "transform"]
    );
    if (decision?.action === "cancel") {
      return { cancelled: true, input: current };
    }
    if (decision?.action === "transform") {
      try {
        assertCompactionInput(decision.value.input);
      } catch (cause) {
        await throwHookFailure(
          state,
          registration,
          "thread.compaction.before",
          cause
        );
      }
      current = structuredClone(decision.value.input);
    }
  }
  return { cancelled: false, input: current };
}

export async function transformModelContext(
  state: PluginRuntimeState,
  threadKey: string,
  messages: readonly ThreadContextMessage[],
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<ThreadContextMessage[]> {
  let current = structuredClone([...messages]);
  for (const { registered, registration } of activeHandlers(
    state,
    "model.context"
  )) {
    const result = await invokeHandler(
      state,
      registration,
      "model.context",
      registered,
      { messages: structuredClone(current) },
      { history, signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["model.context"]
      | undefined;
    await validateRequestResult(
      state,
      registration,
      "model.context",
      decision,
      ["continue", "transform"]
    );
    if (decision?.action === "transform") {
      try {
        assertModelContextEvent(decision.value);
      } catch (cause) {
        await throwHookFailure(state, registration, "model.context", cause);
      }
      current = structuredClone([...decision.value.messages]);
    }
  }
  return current;
}

export async function transformModelStep(
  state: PluginRuntimeState,
  threadKey: string,
  messages: readonly ModelStepOutput[number][],
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<ModelStepOutput> {
  let current: ModelStepOutput = structuredClone([...messages]);
  for (const { registered, registration } of activeHandlers(
    state,
    "model.step.before"
  )) {
    const result = await invokeHandler(
      state,
      registration,
      "model.step.before",
      registered,
      { messages: structuredClone(current) },
      { history, signal, threadKey }
    );
    const decision = result as
      | PluginRequestResultMap["model.step.before"]
      | undefined;
    await validateRequestResult(
      state,
      registration,
      "model.step.before",
      decision,
      ["continue", "transform"]
    );
    if (decision?.action === "transform") {
      try {
        assertModelStep(
          decision.value,
          "Plugin model.step.before transform must return a messages array."
        );
      } catch (cause) {
        await throwHookFailure(state, registration, "model.step.before", cause);
      }
      current = structuredClone([...decision.value.messages]);
    }
  }
  return current;
}

function assertCompactionInput(
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

function assertModelContextEvent(
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

function assertModelStep(
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
