import type { ModelMessage, ToolExecutionOptions } from "ai";
import type { AgentPluginScope } from "./scope";
import type {
  ToolResultHandlerOutput,
  ToolResultState,
} from "./tool-hook-results";
import {
  cloneToolHookValue,
  cloneToolResultState,
  normalizeToolCallResult,
  normalizeToolResultResult,
} from "./tool-hook-results";

interface ToolHandlerOptions {
  readonly history: readonly ModelMessage[];
  readonly input: unknown;
  readonly options: ToolExecutionOptions<unknown>;
  readonly scope: AgentPluginScope;
  readonly signal: AbortSignal;
  readonly tool: string;
}

export async function runToolCallHandlers({
  history,
  input,
  options,
  scope,
  signal,
  tool,
}: ToolHandlerOptions): Promise<
  | { readonly input: unknown; readonly kind: "execute" }
  | {
      readonly input: unknown;
      readonly kind: "synthetic";
      readonly output: unknown;
    }
  | { readonly kind: "error"; readonly message: string }
> {
  let nextInput = cloneToolHookValue(input);

  for (const handler of scope.eventHandlers?.get("tool.call") ?? []) {
    const result = await handler({
      history: cloneToolHookValue(history),
      input: cloneToolHookValue(nextInput),
      overlay: scope.overlay,
      sessionKey: scope.sessionKey,
      signal: options.abortSignal ?? signal,
      steer: scope.steer,
      tool,
      toolCallId: options.toolCallId,
      type: "tool.call",
    });
    const decision = normalizeToolCallResult(result);

    if (!decision || decision.action === "allow") {
      continue;
    }
    if (decision.action === "modify") {
      nextInput = cloneToolHookValue(decision.input);
      continue;
    }
    if (decision.action === "reject-and-continue") {
      return {
        input: nextInput,
        kind: "synthetic",
        output: { message: decision.message, rejected: true },
      };
    }
    if (decision.action === "synthesize") {
      return {
        input: nextInput,
        kind: "synthetic",
        output: cloneToolHookValue(decision.result.output),
      };
    }
    return { kind: "error", message: decision.message };
  }

  return { input: nextInput, kind: "execute" };
}

export async function runToolResultHandlers({
  elapsedMs,
  history,
  input,
  initialState,
  options,
  scope,
  signal,
  tool,
}: ToolHandlerOptions & {
  readonly elapsedMs?: number;
  readonly initialState: ToolResultState;
}): Promise<ToolResultHandlerOutput> {
  let replaced = false;
  let state = cloneToolResultState(initialState);

  for (const handler of scope.eventHandlers?.get("tool.result") ?? []) {
    const result = await handler({
      elapsedMs,
      error: state.error,
      history: cloneToolHookValue(history),
      input: cloneToolHookValue(input),
      overlay: scope.overlay,
      output: cloneToolHookValue(state.output),
      sessionKey: scope.sessionKey,
      signal: options.abortSignal ?? signal,
      status: state.status,
      steer: scope.steer,
      tool,
      toolCallId: options.toolCallId,
      type: "tool.result",
    });
    const replacement = normalizeToolResultResult(result);

    if (replacement) {
      replaced = true;
      state = cloneToolResultState(replacement);
    }
  }

  return { replaced, state: cloneToolResultState(state) };
}
