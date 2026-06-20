import type { ModelMessage } from "ai";
import {
  closeRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import { errorMessage } from "../state/thread-errors";
import {
  ThreadCommitConflictError,
  type ThreadState,
} from "../state/thread-state";

export async function emitTurnErrorAfterRecovery({
  error,
  historySnapshot,
  run,
  runtimeInput,
  state,
}: {
  readonly error: unknown;
  readonly historySnapshot: ModelMessage[];
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
}): Promise<void> {
  if (error instanceof ThreadCommitConflictError) {
    run.emit({ type: "turn-error", message: error.message });
    closeRuntimeInput(runtimeInput, "a thread commit conflict");
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
