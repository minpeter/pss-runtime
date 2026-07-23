import type { AgentEvent, ModelUsage } from "@minpeter/pss-runtime";
import type { TuiStreamPart } from "./tui-stream-handlers";

/**
 * Options accepted by the agent-event to stream-part adapter.
 */
export interface AgentEventStreamOptions {
  /** Receives every normalized model-usage event for footer/telemetry. */
  onModelUsage?: (usage: ModelUsage) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * AI SDK tool outputs use `{ type: "error-text" | "error-json", value }` for
 * failed executions. Those are rendered through the error path so they show
 * up with the error block styling instead of as normal output.
 */
const isErrorToolOutput = (
  output: unknown
): output is { type: "error-json" | "error-text"; value: unknown } =>
  isRecord(output) &&
  (output.type === "error-text" || output.type === "error-json");

const isExecutionDeniedToolOutput = (
  output: unknown
): output is { type: "execution-denied"; reason?: string } =>
  isRecord(output) && output.type === "execution-denied";

/**
 * ai v7 wraps tool results in typed output envelopes
 * (`{ type: "text" | "json", value }`). The TUI renderers — like the
 * plugsuits ones they are ported from — expect the semantic raw value, so
 * unwrap the envelope here at the event boundary.
 */
const unwrapToolOutput = (output: unknown): unknown => {
  if (
    isRecord(output) &&
    (output.type === "text" || output.type === "json") &&
    "value" in output
  ) {
    return output.value;
  }
  return output;
};

/**
 * Translates a pss-runtime `AgentEvent` stream (whole-step granularity) into
 * the finer-grained stream parts the TUI dispatch table renders. The runtime
 * emits complete texts per step, so text/reasoning arrive as a single delta
 * bracketed by start/end parts; tool calls arrive fully formed without
 * input-streaming parts.
 */
export async function* agentEventStreamParts(
  events: AsyncIterable<AgentEvent>,
  options: AgentEventStreamOptions = {}
): AsyncGenerator<TuiStreamPart> {
  let lastFinishReason: string | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "turn-start":
        yield { type: "start" };
        break;
      case "step-start":
        yield { type: "start-step" };
        break;
      case "assistant-reasoning":
        yield { type: "reasoning-start" };
        yield { type: "reasoning-delta", text: event.text };
        yield { type: "reasoning-end" };
        break;
      case "assistant-output":
        yield { type: "text-start" };
        yield { type: "text-delta", text: event.text };
        yield { type: "text-end" };
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
        if (isErrorToolOutput(event.output)) {
          yield {
            type: "tool-error",
            error: event.output.value,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
        } else if (isExecutionDeniedToolOutput(event.output)) {
          yield {
            type: "tool-output-denied",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
        } else {
          yield {
            type: "tool-result",
            output: unwrapToolOutput(event.output),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
        }
        break;
      case "model-usage":
        if (event.finishReason !== undefined) {
          lastFinishReason = event.finishReason;
        }
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
        yield { type: "error", error: event.message };
        break;
      default:
        // user-input / runtime-input echoes are rendered by the TUI itself.
        break;
    }
  }
}
