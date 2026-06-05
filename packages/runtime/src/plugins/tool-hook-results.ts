import type {
  AgentPluginToolCallResult,
  AgentPluginToolResultResult,
  AgentPluginToolResultStatus,
} from "./types";

export interface ToolResultState {
  readonly error?: string;
  readonly output?: unknown;
  readonly status: AgentPluginToolResultStatus;
}

export interface ToolResultHandlerOutput {
  readonly replaced: boolean;
  readonly state: ToolResultState;
}

export function cloneToolHookValue<T>(value: T): T {
  return structuredClone(value);
}

export function cloneToolResultState(state: ToolResultState): ToolResultState {
  return {
    error: state.error,
    output: cloneToolHookValue(state.output),
    status: state.status,
  };
}

export function normalizeToolCallResult(
  result: unknown
): Exclude<AgentPluginToolCallResult, void> | undefined {
  if (result === undefined) {
    return;
  }
  if (!isRecord(result) || typeof result.action !== "string") {
    throw new TypeError("tool.call handlers must return a valid action.");
  }

  if (result.action === "allow") {
    return { action: "allow" };
  }
  if (result.action === "modify") {
    return { action: "modify", input: result.input };
  }
  if (
    (result.action === "error" || result.action === "reject-and-continue") &&
    typeof result.message === "string"
  ) {
    return { action: result.action, message: result.message };
  }
  if (result.action === "synthesize" && isSyntheticResult(result.result)) {
    return { action: "synthesize", result: result.result };
  }

  throw new TypeError("tool.call handlers must return a valid action.");
}

export function normalizeToolResultResult(
  result: unknown
): Exclude<AgentPluginToolResultResult, void> | undefined {
  if (result === undefined) {
    return;
  }
  if (!(isRecord(result) && isToolResultStatus(result.status))) {
    throw new TypeError("tool.result handlers must return a valid status.");
  }

  return {
    error: typeof result.error === "string" ? result.error : undefined,
    output: result.output,
    status: result.status,
  };
}

export function toolResultOutput(state: ToolResultState): unknown {
  if (state.status === "done" || state.output !== undefined) {
    return state.output;
  }

  return { error: state.error, status: state.status };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentPluginToolPolicyError extends Error {
  readonly name = "AgentPluginToolPolicyError";
}

function isSyntheticResult(value: unknown): value is {
  readonly output: unknown;
} {
  return isRecord(value) && "output" in value;
}

function isToolResultStatus(
  value: unknown
): value is AgentPluginToolResultStatus {
  return value === "done" || value === "error" || value === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
