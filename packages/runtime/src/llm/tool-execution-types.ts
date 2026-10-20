/**
 * What crash recovery does with a call whose outcome is unknown: `pure` and
 * `idempotent` calls run again under the same idempotency key, `interrupt`
 * calls report an interrupted error result to the model, and
 * `manual-recovery` calls park the run until `agent.resolveRecovery()`.
 */
export type RuntimeToolRetryPolicy =
  | "idempotent"
  | "interrupt"
  | "manual-recovery"
  | "pure";

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
  /** Records a non-abort execution failure as the call's outcome. */
  readonly afterToolError?: (
    checkpoint: RuntimeToolExecutionCheckpoint,
    error: unknown
  ) => Promise<void> | void;
  readonly attempt: number;
  readonly beforeTool?: (
    checkpoint: RuntimeToolExecutionCheckpoint
  ) => Promise<RuntimeToolExecutionDecision> | RuntimeToolExecutionDecision;
  readonly runId: string;
}
