import type { ModelMessage, ToolSet } from "ai";
import { publicToolCallId } from "./tool-call-ids";
import {
  ToolExecutionNeedsRecoveryError,
  toolErrorText,
} from "./tool-execution-checkpoint";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
  RuntimeToolExecutionResult,
  RuntimeToolRetryPolicy,
} from "./tool-execution-types";
import { ToolStepProgress } from "./tool-step-progress";

export function normalizeToolCallIds(
  tools: ToolSet | undefined,
  toolCallIds: Map<string, string>,
  toolExecution: RuntimeToolExecutionContext | undefined,
  progress?: ToolStepProgress
): ToolSet | undefined {
  if (!tools) {
    return;
  }

  return Object.fromEntries(
    Object.entries(tools).map(([name, candidate]) => [
      name,
      observeToolExecution(
        wrapToolExecute(name, candidate, toolCallIds, toolExecution, progress),
        name,
        toolCallIds,
        progress
      ),
    ])
  ) as ToolSet;
}

function observeToolExecution(
  definition: unknown,
  name: string,
  ids: Map<string, string>,
  progress: ToolStepProgress | undefined
): unknown {
  if (!(progress && isExecutableToolDefinition(definition))) {
    return definition;
  }
  return {
    ...definition,
    execute: async (input: unknown, options: ToolExecutionOptionsLike) => {
      const entry = progress.begin(
        input,
        publicToolCallId(options.toolCallId, ids),
        name
      );
      try {
        const output = await definition.execute(input, options);
        entry.complete(output);
        return output;
      } catch (error) {
        if (error instanceof ToolExecutionNeedsRecoveryError) {
          progress.recordRecoveryError(error);
        }
        entry.failed(
          error,
          !(
            options.abortSignal?.aborted ||
            progress.authorityFailed ||
            error instanceof ToolExecutionNeedsRecoveryError
          )
        );
        throw error;
      }
    },
  };
}

function wrapToolExecute(
  toolName: string,
  toolDefinition: unknown,
  toolCallIds: Map<string, string>,
  toolExecution: RuntimeToolExecutionContext | undefined,
  progress?: ToolStepProgress
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
      const decision = await withAuthority(progress, () =>
        toolExecution.beforeTool?.(checkpoint)
      );
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

      progress?.updateInput(toolCallId, executeInput);

      let output: unknown;
      try {
        output = await execute(executeInput, {
          ...options,
          attempt: checkpoint.attempt,
          idempotencyKey: checkpoint.idempotencyKey,
          retryPolicy: checkpoint.policy,
          ...(options.abortSignal === undefined
            ? {}
            : { signal: options.abortSignal }),
          toolCallId,
        });
      } catch (error) {
        // An aborted call may have partly run: leave its outcome unknown.
        if (!options.abortSignal?.aborted) {
          await withAuthority(progress, () =>
            toolExecution.afterToolError?.(checkpoint, error)
          );
        }
        throw error;
      }
      const transformed: RuntimeToolExecutionResult | undefined =
        await withAuthority(progress, () =>
          toolExecution.afterTool?.({ ...executionCheckpoint, output })
        );
      return transformed ? transformed.output : output;
    },
  };
}

/**
 * Runs a recovered call again through the durable wrapper, so it is
 * journaled like any call. Returns `undefined` when the tool cannot run, its
 * output, or the error text the model receives. Cancellation, a durable
 * hook failure, and a manual-recovery decision still throw.
 */
export async function rerunToolCall({
  attempt,
  input,
  messages,
  signal,
  toolCallId,
  toolDefinition,
  toolExecution,
  toolName,
}: {
  readonly attempt: number;
  readonly input: unknown;
  readonly messages: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly toolCallId: string;
  readonly toolDefinition: unknown;
  readonly toolExecution: RuntimeToolExecutionContext;
  readonly toolName: string;
}): Promise<
  { readonly errorText: string } | { readonly output: unknown } | undefined
> {
  const progress = new ToolStepProgress();
  const wrapped = wrapToolExecute(
    toolName,
    toolDefinition,
    new Map(),
    { ...toolExecution, attempt },
    progress
  );
  if (!isExecutableToolDefinition(wrapped)) {
    return;
  }
  try {
    return {
      output: await wrapped.execute(input, {
        abortSignal: signal,
        messages,
        toolCallId,
      }),
    };
  } catch (error) {
    if (
      signal.aborted ||
      progress.authorityFailed ||
      error instanceof ToolExecutionNeedsRecoveryError
    ) {
      throw error;
    }
    return { errorText: toolErrorText(error) };
  }
}

/** Runs a durable execution hook; its failure revokes recovery authority. */
async function withAuthority<Result>(
  progress: ToolStepProgress | undefined,
  hook: () => Promise<Result> | Result
): Promise<Result> {
  try {
    return await hook();
  } catch (error) {
    progress?.markAuthorityFailure();
    throw error;
  }
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
  readonly messages?: readonly ModelMessage[];
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
    value === "idempotent" ||
    value === "interrupt" ||
    value === "manual-recovery" ||
    value === "pure"
  );
}
