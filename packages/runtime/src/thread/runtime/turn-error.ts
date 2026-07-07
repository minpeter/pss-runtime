import type { ModelMessage } from "ai";
import type { ExecutionHost } from "../../execution/host/types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution";
import {
  closeRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import { errorMessage } from "../state/thread-errors";
import {
  ThreadCommitConflictError,
  type ThreadState,
} from "../state/thread-state";
import type {
  ThreadExecutionRun,
  ThreadExecutionTerminalStatus,
} from "./execution";
import {
  commitThreadStateAndEvents,
  type DurableThreadEventBuffer,
} from "./thread-event-log";

export async function emitTurnErrorAfterRecovery({
  error,
  historySnapshot,
  persistEvent,
  run,
  runtimeInput,
  state,
}: {
  readonly error: unknown;
  readonly historySnapshot: ModelMessage[];
  readonly persistEvent?: (event: AgentEvent) => Promise<void>;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
}): Promise<void> {
  if (error instanceof ThreadCommitConflictError) {
    const event: AgentEvent = { type: "turn-error", message: error.message };
    try {
      await persistEvent?.(event);
    } finally {
      run.emit(event);
    }
    closeRuntimeInput(runtimeInput, "a thread commit conflict");
    return;
  }

  state.rollback(historySnapshot);
  const event: AgentEvent = {
    type: "turn-error",
    message: errorMessage(error),
  };
  try {
    if (persistEvent) {
      await persistEvent(event);
    } else {
      await state.commit();
    }
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

  run.emit(event);
  closeRuntimeInput(runtimeInput, "turn-error");
}

export async function recoverTurnProcessingError({
  durableEvents,
  error,
  executionHost,
  executionRun,
  historySnapshot,
  recordEvent,
  run,
  runtimeInput,
  state,
  threadKey,
}: {
  readonly durableEvents: DurableThreadEventBuffer;
  readonly error: unknown;
  readonly executionHost?: ExecutionHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly historySnapshot: ModelMessage[];
  readonly recordEvent: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const turnError = error instanceof Error ? error : new Error(String(error));
  await executionRun?.complete(executionStatusForError(turnError));
  await emitTurnErrorAfterRecovery({
    error: turnError,
    historySnapshot,
    persistEvent: async (event) => {
      recordEvent(event);
      await commitThreadStateAndEvents({
        buffer: durableEvents,
        executionHost,
        state,
        threadKey,
      });
    },
    run,
    runtimeInput,
    state,
  });
}

function executionStatusForError(error: Error): ThreadExecutionTerminalStatus {
  return error instanceof ToolExecutionNeedsRecoveryError
    ? "needs-recovery"
    : "error";
}
