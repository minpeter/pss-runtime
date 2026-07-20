export type RuntimeToolRetryPolicy = "idempotent" | "manual-recovery" | "pure";

export interface RuntimeToolExecutionCheckpointMetadata {
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly policy: RuntimeToolRetryPolicy;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface RuntimeToolExecutionCheckpoint
  extends RuntimeToolExecutionCheckpointMetadata {
  readonly input: unknown;
}

export type RuntimePersistedToolExecutionCheckpoint =
  RuntimeToolExecutionCheckpointMetadata;

export type RuntimeToolExecutionDecision =
  | { readonly output: unknown; readonly status: "blocked" }
  | { readonly input: unknown; readonly status: "continue" }
  | { readonly status: "needs-recovery" }
  | undefined;

export interface RuntimeToolExecutionResult {
  readonly output: unknown;
}

export interface RuntimeToolExecutionContext {
  readonly afterTool?: (
    checkpoint: RuntimeToolExecutionCheckpoint & { readonly output: unknown }
  ) =>
    | Promise<RuntimeToolExecutionResult | undefined>
    | RuntimeToolExecutionResult
    | undefined;
  readonly attempt: number;
  readonly beforeTool?: (
    checkpoint: RuntimeToolExecutionCheckpoint
  ) => Promise<RuntimeToolExecutionDecision> | RuntimeToolExecutionDecision;
  readonly runId: string;
}
