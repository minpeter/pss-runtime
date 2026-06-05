import type { ModelMessage } from "ai";
import type { BufferedAgentRun } from "./run";
import { closeRuntimeInput, type RuntimeInputState } from "./runtime-input";
import { errorMessage } from "./session-errors";
import { SessionCommitConflictError, type SessionState } from "./session-state";

export async function emitTurnErrorAfterRecovery({
  error,
  historySnapshot,
  run,
  runtimeInput,
  state,
}: {
  readonly error: unknown;
  readonly historySnapshot: ModelMessage[];
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
  readonly state: SessionState;
}): Promise<void> {
  if (error instanceof SessionCommitConflictError) {
    run.emit({ type: "turn-error", message: error.message });
    closeRuntimeInput(runtimeInput, "a session commit conflict");
    return;
  }

  state.rollback(historySnapshot);
  try {
    await state.commit();
  } catch (rollbackError) {
    const rollbackMessage =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
    run.emit({
      type: "turn-error",
      message: `${errorMessage(error)}; history rollback persistence failed: ${rollbackMessage}`,
    });
    closeRuntimeInput(runtimeInput, "turn-error");
    return;
  }

  run.emit({ type: "turn-error", message: errorMessage(error) });
  closeRuntimeInput(runtimeInput, "turn-error");
}
