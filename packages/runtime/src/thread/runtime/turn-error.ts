import type { ModelMessage } from "ai";
import { AgentHookError } from "../../agent/core/hook-error";
import type { AgentHost } from "../../execution/host/types";
import {
  failedRequestMessages,
  safeFailedMessages,
} from "../../llm/failed-request";
import {
  StoppedModelStep,
  StoppedToolRecoveryError,
} from "../../llm/stopped-model-step";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import {
  closeRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import {
  ThreadCommitConflictError,
  type ThreadState,
} from "../state/thread-state";
import type {
  ThreadExecutionRun,
  ThreadExecutionTerminalStatus,
} from "./execution";
import {
  commitTerminalThreadStateAndEvents,
  type DurableThreadEventBuffer,
} from "./thread-event-log";
import { normalizeTurnError } from "./turn-error-metadata";

type TurnErrorEvent = Extract<AgentEvent, { type: "turn-error" }>;

export class QueuedInputRecoveryError extends Error {
  readonly checkpoint: NonNullable<
    ReturnType<ThreadState["continuationCheckpoint"]>
  >;
  constructor(
    cause: unknown,
    checkpoint: NonNullable<ReturnType<ThreadState["continuationCheckpoint"]>>
  ) {
    super(
      "Task requires recovery before new work can start. Resolve the reported runtime or storage failure and reconcile pending input.",
      { cause }
    );
    this.checkpoint = checkpoint;
  }
}

export async function emitTurnErrorAfterRecovery({
  error,
  historySnapshot,
  persistEvent,
  observeEvent,
  run,
  runtimeInput,
  state,
}: {
  readonly error: unknown;
  readonly historySnapshot: ModelMessage[];
  readonly observeEvent?: (event: AgentEvent) => Promise<void>;
  readonly persistEvent?: (event: AgentEvent) => Promise<void>;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
}): Promise<void> {
  if (isErrorInstance(error, ThreadCommitConflictError)) {
    let event: TurnErrorEvent = {
      type: "turn-error",
      message: "Thread state changed before the turn could be saved.",
    };
    event = await observeTurnError(event, observeEvent);
    try {
      await persistEvent?.(event);
    } finally {
      // Publication must follow terminal persistence: that commit advances
      // the version used to validate this recovery sentinel on refresh.
      state.setContinuationCheckpoint(state.modelSnapshot(), () => {
        throw new Error(
          "Task requires recovery because another writer changed this thread. Reload the session and reconcile its stored history before continuing.",
          { cause: error }
        );
      });
      run.emit(event);
    }
    closeRuntimeInput(runtimeInput, "a thread commit conflict");
    return;
  }

  const partial = isErrorInstance(error, StoppedModelStep)
    ? error.messages
    : failedRequestMessages(error);
  const safeHistory = state.modelSnapshot();
  const continuation =
    partial === undefined ? undefined : [...state.modelSnapshot(), ...partial];
  const { safeHookRetry, retainedHistory } = hookFailureHistory(
    error,
    safeHistory,
    historySnapshot
  );
  state.rollback(retainedHistory);
  const normalizedError = normalizeTurnError(error);
  const recoveryRequired = isErrorInstance(error, QueuedInputRecoveryError);
  const message = turnFailureMessage(error, normalizedError.message);
  let event: TurnErrorEvent = {
    ...(normalizedError.error === undefined
      ? {}
      : { error: normalizedError.error }),
    ...(recoveryRequired
      ? {
          error: {
            ...normalizedError.error,
            category: normalizedError.error?.category ?? "unknown",
            version: 1 as const,
            code: "THREAD_RECOVERY_REQUIRED",
          },
        }
      : {}),
    type: "turn-error",
    message,
  };
  event = await observeTurnError(event, observeEvent);
  try {
    if (persistEvent) {
      await persistEvent(event);
    } else {
      await state.commit();
    }
  } catch (persistenceError) {
    state.setContinuationCheckpoint(continuation ?? safeHistory, () => {
      throw new Error(
        "Task requires storage recovery: terminal state could not be saved. Repair storage and reconcile the recorded turn before continuing.",
        { cause: persistenceError }
      );
    });
    run.emit({
      ...(event.error === undefined ? {} : { error: event.error }),
      type: "turn-error",
      message: `${event.message} History rollback persistence failed.`,
    });
    closeRuntimeInput(runtimeInput, "turn-error");
    throw persistenceError;
  }

  if (isErrorInstance(error, QueuedInputRecoveryError)) {
    state.setContinuationCheckpoint(
      error.checkpoint.history,
      error.checkpoint.recover
    );
  } else if (safeHookRetry) {
    state.clearContinuationCheckpoint();
  } else if (continuation) {
    state.setContinuationCheckpoint(continuation);
  } else if (isErrorInstance(error, StoppedToolRecoveryError)) {
    state.setContinuationCheckpoint(safeHistory, () => [
      ...safeHistory,
      ...error.recover(),
    ]);
  } else {
    state.setContinuationCheckpoint(
      retainedHistory === historySnapshot ? safeHistory : retainedHistory,
      () => {
        throw new Error(
          "Task is pending but runtime recovery is required. Resolve the reported runtime or storage failure before starting new work.",
          { cause: error }
        );
      }
    );
  }
  run.emit(event);
  closeRuntimeInput(runtimeInput, "turn-error");
}

function hookFailureHistory(
  error: unknown,
  safeHistory: ModelMessage[],
  historySnapshot: ModelMessage[]
) {
  if (!isErrorInstance(error, AgentHookError)) {
    return { retainedHistory: historySnapshot, safeHookRetry: false };
  }
  const output = error.modelOutput ?? [];
  const hasEffects = [
    ...safeHistory.slice(historySnapshot.length),
    ...output,
  ].some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call"))
  );
  return {
    retainedHistory: hasEffects
      ? [...safeHistory, ...safeFailedMessages(output)]
      : historySnapshot,
    safeHookRetry:
      !hasEffects &&
      (error.hook === "beforeTurnStart" ||
        error.hook === "transformModelContext" ||
        error.hook === "transformModelStep"),
  };
}

function turnFailureMessage(
  error: unknown,
  fallback: string | undefined
): string {
  if (isErrorInstance(error, StoppedModelStep)) {
    return "Output limit reached before completion. Press Enter to continue from retained progress.";
  }
  if (
    isErrorInstance(error, StoppedToolRecoveryError) ||
    isErrorInstance(error, QueuedInputRecoveryError)
  ) {
    return error.message;
  }
  return fallback ?? "The request failed.";
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
  readonly executionHost?: AgentHost;
  readonly executionRun?: ThreadExecutionRun;
  readonly historySnapshot: ModelMessage[];
  readonly recordEvent: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  await emitTurnErrorAfterRecovery({
    error,
    historySnapshot,
    observeEvent: undefined,
    persistEvent: async (event) => {
      recordEvent(event);
      await commitTerminalThreadStateAndEvents({
        buffer: durableEvents,
        executionHost,
        executionRun,
        state,
        status: executionStatusForError(error),
        threadKey,
      });
    },
    run,
    runtimeInput,
    state,
  });
}

async function observeTurnError(
  event: TurnErrorEvent,
  observeEvent: ((event: AgentEvent) => Promise<void>) | undefined
): Promise<TurnErrorEvent> {
  if (!observeEvent) {
    return event;
  }
  try {
    await observeEvent(event);
    return event;
  } catch {
    return {
      message: `${"message" in event ? event.message : "Turn failed"}; turn.error plugin failed.`,
      type: "turn-error",
    };
  }
}

function executionStatusForError(
  error: unknown
): ThreadExecutionTerminalStatus {
  return isErrorInstance(error, ToolExecutionNeedsRecoveryError) ||
    isErrorInstance(error, StoppedToolRecoveryError)
    ? "needs-recovery"
    : "error";
}

function isErrorInstance<T>(
  error: unknown,
  errorType: {
    new (...args: never[]): T;
    readonly [Symbol.hasInstance]: (value: unknown) => boolean;
  }
): error is T {
  try {
    return errorType[Symbol.hasInstance](error);
  } catch {
    return false;
  }
}
