import { matchField } from "./matchers";
import type { EvalRun, EvalToolCall, ToolCallMatcherOptions } from "./types";

export function isMatchingCall(
  call: EvalToolCall,
  runs: readonly EvalRun[],
  name: string,
  options: ToolCallMatcherOptions
): boolean {
  if (call.toolName !== name) {
    return false;
  }
  if (options.input !== undefined && !matchField(options.input, call.input)) {
    return false;
  }
  if (options.output !== undefined) {
    const result = runs
      .flatMap((r) => r.toolResults)
      .find((r) => r.toolCallId === call.toolCallId);
    if (!(result && matchField(options.output, result.output))) {
      return false;
    }
  }
  return true;
}
