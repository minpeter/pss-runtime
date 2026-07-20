import type { ModelMessage } from "ai";
import type { AgentEvent } from "../thread/protocol/events";
import type { ThreadCompactionInput } from "../thread/state/thread-state";
import { notifyHandlers } from "./plugin-invocation";
import type { PluginRuntimeState } from "./plugin-types";

export function notifyCompacted(
  state: PluginRuntimeState,
  threadKey: string,
  input: ThreadCompactionInput,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<void> {
  return notifyHandlers(
    state,
    "thread.compaction.after",
    { input: structuredClone(input) },
    { history, signal, threadKey }
  );
}

export function startThread(
  state: PluginRuntimeState,
  threadKey: string,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<void> {
  return notifyHandlers(
    state,
    "thread.start",
    {},
    {
      history,
      signal,
      threadKey,
    }
  );
}

export function shutdownThread(
  state: PluginRuntimeState,
  threadKey: string,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<void> {
  return notifyHandlers(
    state,
    "thread.shutdown",
    {},
    {
      history,
      signal,
      threadKey,
    }
  );
}

export async function observeAgentEvent(
  state: PluginRuntimeState,
  threadKey: string,
  event: AgentEvent,
  history: readonly ModelMessage[],
  signal: AbortSignal
): Promise<void> {
  const context = { history, signal, threadKey };
  switch (event.type) {
    case "assistant-output":
    case "assistant-reasoning":
      await notifyHandlers(state, "message.start", event, context);
      await notifyHandlers(state, "message.update", event, context);
      await notifyHandlers(state, "message.end", event, context);
      return;
    case "step-start":
      await notifyHandlers(state, "step.start", event, context);
      return;
    case "step-end":
      await notifyHandlers(state, "step.end", event, context);
      return;
    case "model-usage":
      await notifyHandlers(state, "model.usage", event, context);
      return;
    case "turn-start":
      await notifyHandlers(state, "turn.start", event, context);
      return;
    case "turn-end":
      await notifyHandlers(state, "turn.end", event, context);
      await notifyHandlers(state, "turn.settled", event, context);
      return;
    case "turn-abort":
      await notifyHandlers(state, "turn.abort", event, context);
      await notifyHandlers(state, "turn.settled", event, context);
      return;
    case "turn-error":
      await notifyHandlers(state, "turn.error", event, context);
      await notifyHandlers(state, "turn.settled", event, context);
      return;
    default:
      return;
  }
}
