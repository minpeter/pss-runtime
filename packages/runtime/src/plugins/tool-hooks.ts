import type { ModelMessage, ToolExecutionOptions, ToolSet } from "ai";
import type { AgentPluginScope } from "./scope";
import { getActiveAgentPluginScope, runWithAgentPluginScope } from "./scope";
import {
  runToolCallHandlers,
  runToolResultHandlers,
} from "./tool-hook-handlers";
import {
  AgentPluginToolPolicyError,
  errorMessage,
  toolResultOutput,
} from "./tool-hook-results";

interface ToolHookWrapOptions {
  readonly history: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly tools?: ToolSet;
}

interface ExecuteWithToolHooksOptions {
  readonly execute: (
    input: unknown,
    options: ToolExecutionOptions<unknown>
  ) => unknown;
  readonly history: readonly ModelMessage[];
  readonly input: unknown;
  readonly options: ToolExecutionOptions<unknown>;
  readonly scope: AgentPluginScope;
  readonly signal: AbortSignal;
  readonly tool: string;
}

const toolHookQueues = new WeakMap<AgentPluginScope, Promise<void>>();

export function wrapToolsWithPluginHooks({
  history,
  signal,
  tools,
}: ToolHookWrapOptions): ToolSet | undefined {
  const scope = getActiveAgentPluginScope();
  if (!(tools && scope && hasToolHookHandlers(scope))) {
    return tools;
  }

  const wrapped: ToolSet = {};
  for (const toolName of Object.keys(tools)) {
    const currentTool = tools[toolName];
    const execute = currentTool?.execute;
    if (!currentTool || typeof execute !== "function") {
      if (currentTool) {
        wrapped[toolName] = currentTool;
      }
      continue;
    }

    wrapped[toolName] = {
      ...currentTool,
      execute: (input: unknown, options: ToolExecutionOptions<unknown>) =>
        executeWithToolHooks({
          execute,
          history,
          input,
          options,
          scope,
          signal,
          tool: toolName,
        }),
    };
  }

  return wrapped;
}

function executeWithToolHooks(
  options: ExecuteWithToolHooksOptions
): Promise<unknown> {
  return runExclusiveToolHooks(options.scope, () =>
    runWithAgentPluginScope(options.scope, () =>
      executeWithScopedToolHooks(options)
    )
  );
}

async function executeWithScopedToolHooks({
  execute,
  history,
  input,
  options,
  scope,
  signal,
  tool,
}: ExecuteWithToolHooksOptions): Promise<unknown> {
  const callDecision = await runToolCallHandlers({
    history,
    input,
    options,
    scope,
    signal,
    tool,
  });

  if (callDecision.kind === "error") {
    throw new AgentPluginToolPolicyError(callDecision.message);
  }

  if (callDecision.kind === "synthetic") {
    const result = await runToolResultHandlers({
      history,
      input: callDecision.input,
      initialState: { output: callDecision.output, status: "done" },
      options,
      scope,
      signal,
      tool,
    });
    return toolResultOutput(result.state);
  }

  const startedAt = Date.now();
  try {
    const output = await execute(callDecision.input, options);
    const result = await runToolResultHandlers({
      elapsedMs: Date.now() - startedAt,
      history,
      input: callDecision.input,
      initialState: { output, status: "done" },
      options,
      scope,
      signal,
      tool,
    });
    return toolResultOutput(result.state);
  } catch (error) {
    const result = await runToolResultHandlers({
      elapsedMs: Date.now() - startedAt,
      history,
      input: callDecision.input,
      initialState: { error: errorMessage(error), status: "error" },
      options,
      scope,
      signal,
      tool,
    });
    if (!result.replaced) {
      throw error;
    }
    return toolResultOutput(result.state);
  }
}

async function runExclusiveToolHooks<T>(
  scope: AgentPluginScope,
  callback: () => Promise<T>
): Promise<T> {
  const previous = toolHookQueues.get(scope) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  toolHookQueues.set(
    scope,
    previous.then(() => current)
  );

  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function hasToolHookHandlers(scope: AgentPluginScope): boolean {
  return (
    (scope.eventHandlers?.get("tool.call")?.length ?? 0) > 0 ||
    (scope.eventHandlers?.get("tool.result")?.length ?? 0) > 0
  );
}
