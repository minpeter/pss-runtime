import type { AssistantModelMessage, ToolModelMessage, ToolSet } from "ai";
import type { RuntimeLlmOutput } from "./llm";

const toolCallIdPrefix = "call_";
const publicToolCallIdPattern = /^call[-_]/;

type RuntimeLlmMessage = RuntimeLlmOutput[number];

export type RuntimeToolRetryPolicy = "idempotent" | "manual-recovery" | "pure";

export interface RuntimeToolExecutionCheckpoint {
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly policy: RuntimeToolRetryPolicy;
  readonly toolCallId: string;
  readonly toolName: string;
}

export type RuntimeToolExecutionDecision =
  | { readonly status: "needs-recovery" }
  | undefined;

export interface RuntimeToolExecutionContext {
  readonly afterTool?: (
    checkpoint: RuntimeToolExecutionCheckpoint & { readonly output: unknown }
  ) => Promise<void> | void;
  readonly attempt: number;
  readonly beforeTool?: (
    checkpoint: RuntimeToolExecutionCheckpoint
  ) => Promise<RuntimeToolExecutionDecision> | RuntimeToolExecutionDecision;
  readonly runId: string;
}

export class ToolExecutionNeedsRecoveryError extends Error {
  readonly idempotencyKey: string;
  readonly status = "needs-recovery";
  readonly toolCallId: string;
  readonly toolName: string;

  constructor(checkpoint: RuntimeToolExecutionCheckpoint) {
    super(
      `Tool ${checkpoint.toolName} requires manual recovery for ${checkpoint.idempotencyKey}`
    );
    this.idempotencyKey = checkpoint.idempotencyKey;
    this.name = "ToolExecutionNeedsRecoveryError";
    this.toolCallId = checkpoint.toolCallId;
    this.toolName = checkpoint.toolName;
  }
}

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

export function rewriteMessageToolCallIds(
  message: RuntimeLlmMessage,
  toolCallIds: Map<string, string>
): RuntimeLlmMessage {
  if (message.role === "assistant") {
    return rewriteAssistantToolCallIds(message, toolCallIds);
  }

  if (message.role === "tool") {
    return rewriteToolResultCallIds(message, toolCallIds);
  }

  return message;
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

      const output = await execute(input, {
        ...options,
        attempt: checkpoint.attempt,
        idempotencyKey: checkpoint.idempotencyKey,
        retryPolicy: checkpoint.policy,
        ...(options.abortSignal === undefined
          ? {}
          : { signal: options.abortSignal }),
        toolCallId,
      });
      await toolExecution.afterTool?.({ ...checkpoint, output });
      return output;
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

function rewriteAssistantToolCallIds(
  message: AssistantModelMessage,
  toolCallIds: Map<string, string>
): AssistantModelMessage {
  if (typeof message.content === "string") {
    return message;
  }

  return {
    ...message,
    content: message.content.map((part) =>
      "toolCallId" in part
        ? {
            ...part,
            toolCallId: publicToolCallId(part.toolCallId, toolCallIds),
          }
        : part
    ),
  };
}

function rewriteToolResultCallIds(
  message: ToolModelMessage,
  toolCallIds: Map<string, string>
): ToolModelMessage {
  return {
    ...message,
    content: message.content.map((part) =>
      "toolCallId" in part
        ? {
            ...part,
            toolCallId: publicToolCallId(part.toolCallId, toolCallIds),
          }
        : part
    ),
  };
}

function publicToolCallId(
  toolCallId: string,
  toolCallIds: Map<string, string>
): string {
  if (publicToolCallIdPattern.test(toolCallId)) {
    return toolCallId;
  }

  const existing = toolCallIds.get(toolCallId);
  if (existing) {
    return existing;
  }

  const generated = createToolCallId();
  toolCallIds.set(toolCallId, generated);
  return generated;
}

function createToolCallId(): string {
  return `${toolCallIdPrefix}${crypto.randomUUID().replaceAll("-", "")}`;
}
