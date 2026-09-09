import type {
  AgentEvent,
  ContextUsageSnapshot,
  ModelUsage,
} from "@minpeter/pss-runtime";
import { createTuiErrorPresentation } from "./error-presentation";
import type { TuiStreamPart } from "./stream-handlers";
import { toolResultStreamPart } from "./tool-result-stream-part";

/**
 * Options accepted by the agent-event to stream-part adapter.
 */
export interface AgentEventStreamOptions {
  onContextUsage?: (snapshot: ContextUsageSnapshot) => void;
  onModelUsage?: (usage: ModelUsage) => void;
}

type AssistantContentKind = "reasoning" | "text";

function* assistantDeltaParts(
  kind: AssistantContentKind,
  text: string,
  sawDelta: boolean
): Generator<TuiStreamPart> {
  if (!sawDelta) {
    yield { type: `${kind}-start` };
  }
  yield { type: `${kind}-delta`, text };
}

function* committedAssistantContentParts(
  kind: AssistantContentKind,
  text: string,
  sawDelta: boolean
): Generator<TuiStreamPart> {
  if (!sawDelta) {
    yield* assistantDeltaParts(kind, text, false);
  }
  yield { type: `${kind}-end` };
}

/**
 * Translates a pss-runtime `AgentEvent` stream into the finer-grained stream
 * parts the TUI dispatch table renders. Live text, reasoning, and tool-input
 * deltas are forwarded incrementally. The committed per-step events provide
 * closing boundaries and remain the fallback for providers without deltas.
 */
export async function* agentEventStreamParts(
  events: AsyncIterable<AgentEvent>,
  options: AgentEventStreamOptions = {}
): AsyncGenerator<TuiStreamPart> {
  let lastFinishReason: string | undefined;
  let sawReasoningDelta = false;
  let sawTextDelta = false;

  for await (const event of events) {
    switch (event.type) {
      case "context-usage":
        options.onContextUsage?.(event);
        break;
      case "turn-start":
        yield { type: "start" };
        break;
      case "step-start":
        sawReasoningDelta = false;
        sawTextDelta = false;
        yield { type: "start-step" };
        break;
      case "assistant-reasoning-delta":
        yield* assistantDeltaParts("reasoning", event.text, sawReasoningDelta);
        sawReasoningDelta = true;
        break;
      case "assistant-reasoning":
        yield* committedAssistantContentParts(
          "reasoning",
          event.text,
          sawReasoningDelta
        );
        break;
      case "assistant-output-delta":
        yield* assistantDeltaParts("text", event.text, sawTextDelta);
        sawTextDelta = true;
        break;
      case "assistant-output":
        yield* committedAssistantContentParts("text", event.text, sawTextDelta);
        break;
      case "tool-call-input-start":
        yield {
          type: "tool-input-start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
        break;
      case "tool-call-input-delta":
        yield {
          type: "tool-input-delta",
          inputTextDelta: event.inputTextDelta,
          toolCallId: event.toolCallId,
        };
        break;
      case "tool-call-input-end":
        yield {
          type: "tool-input-end",
          toolCallId: event.toolCallId,
        };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          input: event.input,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
        break;
      case "tool-result":
        yield toolResultStreamPart(event);
        break;
      case "model-retry":
        // Live-only retry state. Forwarded as a stream part so the TUI's one
        // dispatch table stays the sole renderer, but it never becomes a
        // transcript row: the wait only drives the foreground status.
        yield { ...event, type: "retry-wait" };
        break;
      case "model-usage":
        lastFinishReason = event.finishReason;
        options.onModelUsage?.(event);
        break;
      case "step-end":
        yield { type: "finish-step", finishReason: lastFinishReason };
        break;
      case "turn-end":
        yield { type: "finish", finishReason: lastFinishReason ?? "stop" };
        break;
      case "turn-abort":
        yield { type: "abort", reason: "interrupted" };
        break;
      case "turn-error":
        yield {
          type: "error",
          error: createTuiErrorPresentation(
            event.message,
            event.error ?? { category: "unknown", version: 1 }
          ),
        };
        break;
      default:
        // user-input / runtime-input echoes are rendered by the TUI itself.
        break;
    }
  }
}
