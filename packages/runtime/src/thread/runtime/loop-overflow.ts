import {
  ContextBudgetExceededError,
  type ModelGenerationOptions,
} from "../../llm/llm";
import type { ThreadCompactionInput, ThreadState } from "../state/thread-state";
import {
  compactThreadBlocking,
  type ThreadModelContextTransform,
} from "./auto-compaction";
import type { ThreadExecutionOptions } from "./execution";

export async function runAgentLoopWithOverflowCompaction({
  compact,
  execution,
  model,
  runLoop,
  state,
  transformModelContext,
}: {
  readonly compact?: (input: ThreadCompactionInput) => Promise<boolean>;
  readonly execution: ThreadExecutionOptions;
  readonly model: ModelGenerationOptions;
  readonly runLoop: () => Promise<"aborted" | "completed">;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<"aborted" | "completed"> {
  try {
    return await runLoop();
  } catch (error) {
    const gateOverflow = error instanceof ContextBudgetExceededError;
    if (gateOverflow && error.onOverflow === "error") {
      throw error;
    }

    if (!(gateOverflow || isContextOverflowError(error))) {
      throw error;
    }

    let compacted = false;
    try {
      compacted = await compactThreadBlocking({
        compact,
        model,
        policy: execution.autoCompaction,
        state,
        transformModelContext,
      });
    } catch {
      throw error;
    }

    if (!compacted) {
      throw error;
    }

    return await runLoop();
  }
}

function isContextOverflowError(error: unknown, depth = 0): boolean {
  if (depth > 6) {
    return false;
  }

  if (typeof error === "string") {
    return hasContextOverflowText(error);
  }

  if (!isObjectRecord(error)) {
    return false;
  }

  if (
    hasContextOverflowText(errorText(error, "name")) ||
    hasContextOverflowText(errorText(error, "code")) ||
    hasContextOverflowText(errorText(error, "message"))
  ) {
    return true;
  }

  if (isContextOverflowError(error.cause, depth + 1)) {
    return true;
  }

  return Array.isArray(error.errors)
    ? error.errors.some((item) => isContextOverflowError(item, depth + 1))
    : false;
}

function hasContextOverflowText(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("context_length_exceeded") ||
    normalized.includes("context length") ||
    normalized.includes("context limit") ||
    normalized.includes("context window") ||
    normalized.includes("maximum context") ||
    normalized.includes("prompt is too long") ||
    normalized.includes("too many tokens") ||
    normalized.includes("token limit")
  );
}

function errorText(
  value: Record<string, unknown>,
  property: "code" | "message" | "name"
): string {
  const field = value[property];
  return typeof field === "string" ? field : "";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
