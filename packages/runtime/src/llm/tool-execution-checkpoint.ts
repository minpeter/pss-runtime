import type {
  RuntimePersistedToolExecutionCheckpoint,
  RuntimeToolExecutionCheckpointMetadata,
} from "./tool-execution-types";

export class ToolExecutionNeedsRecoveryError extends Error {
  readonly idempotencyKey: string;
  readonly status = "needs-recovery";
  readonly toolCallId: string;
  readonly toolName: string;

  constructor(checkpoint: RuntimeToolExecutionCheckpointMetadata) {
    super(
      `Tool ${checkpoint.toolName} requires manual recovery for ${checkpoint.idempotencyKey}`
    );
    this.idempotencyKey = checkpoint.idempotencyKey;
    this.name = "ToolExecutionNeedsRecoveryError";
    this.toolCallId = checkpoint.toolCallId;
    this.toolName = checkpoint.toolName;
  }
}

export function persistedToolExecutionCheckpoint(
  checkpoint: RuntimeToolExecutionCheckpointMetadata
): RuntimePersistedToolExecutionCheckpoint {
  return {
    attempt: checkpoint.attempt,
    idempotencyKey: checkpoint.idempotencyKey,
    policy: checkpoint.policy,
    toolCallId: checkpoint.toolCallId,
    toolName: checkpoint.toolName,
  };
}
