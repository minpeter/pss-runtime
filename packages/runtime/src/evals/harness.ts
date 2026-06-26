import type { AgentEvent } from "../thread/protocol/events";
import type {
  EvalRun,
  EvalThreadLike,
  EvalToolCall,
  EvalToolResult,
} from "./types";

/**
 * Drive a single turn on a real agent thread and reduce its event stream into
 * an {@link EvalRun}. This is the only bridge between evals and the runtime:
 * no separate agent universe, just `thread.send()` + `turn.events()` drained
 * to completion.
 */
export async function runAgent(
  thread: EvalThreadLike,
  input: string
): Promise<EvalRun> {
  const turn = await thread.send(input);
  const events: AgentEvent[] = [];
  const output: string[] = [];
  const toolCalls: EvalToolCall[] = [];
  const toolResults: EvalToolResult[] = [];
  let error: string | undefined;

  for await (const event of turn.events()) {
    events.push(event);
    switch (event.type) {
      case "assistant-output":
        output.push(event.text);
        break;
      case "tool-call":
        toolCalls.push({
          input: event.input,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
        break;
      case "tool-result":
        toolResults.push({
          output: event.output,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
        break;
      case "turn-error":
        error = event.message;
        break;
      default:
        break;
    }
  }

  return {
    error,
    events,
    output: output.join(""),
    toolCalls,
    toolResults,
  };
}
