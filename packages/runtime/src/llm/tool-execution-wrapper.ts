import type { ToolSet } from "ai";
import { publicToolCallId } from "./tool-call-ids";
import { ToolExecutionNeedsRecoveryError } from "./tool-execution-checkpoint";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
  RuntimeToolRetryPolicy,
} from "./tool-execution-types";

export function normalizeToolCallIds(
  tools: ToolSet | undefined,
  toolCallIds: Map<string, string>,
  toolExecution: RuntimeToolExecutionContext | undefined
): ToolSet | undefined {
  if (!tools) {
    return;
  }

  return Object.fromEntries(
    Object.entries(tools).map(([name, candidate]) => [
      name,
      wrapToolExecute(name, candidate, toolCallIds, toolExecution),
    ])
  ) as ToolSet;
}

function wrapToolExecute(
  toolName: string,
  toolDefinition: unknown,
  toolCallIds: Map<string, string>,
  toolExecution: RuntimeToolExecutionContext | undefined
): unknown {
  if (!isExecutableToolDefinition(toolDefinition)) {
    return toolDefinition;
  }

  const { execute } = toolDefinition;
  if (!toolExecution) {
    return {
      ...toolDefinition,
      execute: (input: unknown, options: ToolExecutionOptionsLike) =>
        execute(input, {
          ...options,
          toolCallId: publicToolCallId(options.toolCallId, toolCallIds),
        }),
    };
  }

  return {
    ...toolDefinition,
    execute: async (input: unknown, options: ToolExecutionOptionsLike) => {
      const toolCallId = publicToolCallId(options.toolCallId, toolCallIds);
      const checkpoint = toolCheckpoint({
        input,
        policy: toolRetryPolicy(toolDefinition),
        toolCallId,
        toolExecution,
        toolName,
      });
      const decision = await toolExecution.beforeTool?.(checkpoint);
      if (decision?.status === "needs-recovery") {
        throw new ToolExecutionNeedsRecoveryError(checkpoint);
      }
      if (decision?.status === "blocked") {
        return decision.output;
      }
      const executeInput =
        decision?.status === "continue" ? decision.input : input;
      const executionCheckpoint =
        decision?.status === "continue"
          ? { ...checkpoint, input: executeInput }
          : checkpoint;

      const output = await execute(executeInput, {
        ...options,
        attempt: checkpoint.attempt,
        idempotencyKey: checkpoint.idempotencyKey,
        retryPolicy: checkpoint.policy,
        ...(options.abortSignal === undefined
          ? {}
          : { signal: options.abortSignal }),
        toolCallId,
      });
      const transformed = await toolExecution.afterTool?.({
        ...executionCheckpoint,
        output,
      });
      return transformed ? transformed.output : output;
    },
  };
}

function isExecutableToolDefinition(value: unknown): value is {
  readonly execute: (
    input: unknown,
    options: RuntimeToolExecutionOptionsLike | ToolExecutionOptionsLike
  ) => unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

interface ToolExecutionOptionsLike {
  readonly abortSignal?: AbortSignal;
  readonly toolCallId: string;
}

interface RuntimeToolExecutionOptionsLike extends ToolExecutionOptionsLike {
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly retryPolicy: RuntimeToolRetryPolicy;
  readonly signal?: AbortSignal;
}

function toolCheckpoint({
  input,
  policy,
  toolCallId,
  toolExecution,
  toolName,
}: {
  readonly input: unknown;
  readonly policy: RuntimeToolRetryPolicy;
  readonly toolCallId: string;
  readonly toolExecution: RuntimeToolExecutionContext;
  readonly toolName: string;
}): RuntimeToolExecutionCheckpoint {
  return {
    attempt: toolExecution.attempt,
    idempotencyKey: `${toolExecution.runId}:${toolCallId}`,
    input,
    policy,
    toolCallId,
    toolName,
  };
}

function toolRetryPolicy(toolDefinition: unknown): RuntimeToolRetryPolicy {
  if (
    typeof toolDefinition === "object" &&
    toolDefinition !== null &&
    "retryPolicy" in toolDefinition &&
    isToolRetryPolicy(toolDefinition.retryPolicy)
  ) {
    return toolDefinition.retryPolicy;
  }

  return "manual-recovery";
}

function isToolRetryPolicy(value: unknown): value is RuntimeToolRetryPolicy {
  return (
    value === "idempotent" || value === "manual-recovery" || value === "pure"
  );
}
