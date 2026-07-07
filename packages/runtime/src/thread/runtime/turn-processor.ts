import { runAgentLoop } from "../../agent/loop/loop";
import type { ModelGenerationOptions } from "../../llm/llm";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution";
import { stageUserInputAttachments } from "../input/attachments";
import {
  closeRuntimeInput,
  type QueuedInput,
  type RuntimeInputState,
  withRuntimeInputWindow,
} from "../input/runtime-input";
import {
  commitPreUserRuntimeInputs,
  emitCommittedRuntimeInputs,
} from "../input/runtime-input-emit";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import { errorMessage } from "../state/thread-errors";
import type { ThreadState } from "../state/thread-state";
import { scheduleThreadAutoCompaction } from "./auto-compaction";
import { drainRuntimeInput } from "./drain";
import {
  commitAndAckDurableThreadInput,
  releaseDurableThreadInputClaim,
} from "./durable-inputs";
import type { ThreadEventDispatcher } from "./events";
import {
  startThreadExecutionRun,
  type ThreadExecutionOptions,
  type ThreadExecutionRun,
  type ThreadExecutionTerminalStatus,
} from "./execution";
import { runAgentLoopWithOverflowCompaction } from "./loop-overflow";
import {
  commitThreadStateAndEvents,
  type DurableThreadEventBuffer,
  flushDurableThreadEvents,
  recordDurableThreadEvent,
} from "./thread-event-log";
import { emitTurnErrorAfterRecovery } from "./turn-error";
import { emitTurnEvent } from "./turn-events";

interface ActiveTurn {
  readonly abort: AbortController;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly turnId: string;
}

interface ProcessQueuedInputOptions {
  readonly activate: (turn: ActiveTurn) => void;
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly execution: ThreadExecutionOptions;
  readonly item: QueuedInput;
  readonly model: ModelGenerationOptions;
  readonly release: () => void;
  readonly state: ThreadState;
  readonly threadKey: string;
}

export async function processQueuedInput({
  activate,
  deactivateRun,
  events,
  execution,
  item,
  model,
  release,
  threadKey,
  state,
}: ProcessQueuedInputOptions): Promise<void> {
  const activeAbort = new AbortController();
  const {
    durableInputClaim,
    awaitBoundaries = true,
    initialEvents,
    input: queuedInput,
    preUserRuntimeInputs,
    run,
    runtimeInput,
  } = item;
  const input = durableInputClaim?.input ?? queuedInput;
  const turnId = crypto.randomUUID();
  activate({
    abort: activeAbort,
    run,
    runtimeInput,
    turnId,
  });
  const historySnapshot = state.modelSnapshot();
  let executionRun: ThreadExecutionRun | undefined;
  let pendingDurableInputClaim = durableInputClaim;
  const durableEvents: DurableThreadEventBuffer = [];
  const recordEvent = (event: AgentEvent) =>
    recordDurableThreadEvent(durableEvents, event);

  try {
    executionRun = await startThreadExecutionRun({
      executionHost: execution.executionHost,
      interceptToolCall: (checkpoint) =>
        events.interceptBeforeToolCall(checkpoint),
      threadKey,
      state,
      turnId,
    });
    for (const event of initialEvents) {
      const processed = await events.emitRunEvent(run, event);
      if (processed !== "handled") {
        recordEvent(processed);
      }
    }
    const committedPreUser = await commitPreUserRuntimeInputs(
      events,
      state,
      preUserRuntimeInputs,
      model.attachmentStore
    );
    if (input) {
      state.appendUserInput(
        await stageUserInputAttachments(input, model.attachmentStore, {
          trustRuntimeAttachmentRefs: true,
        })
      );
      if (pendingDurableInputClaim) {
        await commitAndAckDurableThreadInput({
          executionHost: execution.executionHost,
          record: pendingDurableInputClaim,
          state,
        });
        pendingDurableInputClaim = undefined;
      } else {
        await state.commit();
      }
      recordEvent(item.acceptedEvent ?? input);
    }
    await withRuntimeInputWindow(runtimeInput, "turn-start", async () => {
      await events.emitRunBoundaryEvent(
        run,
        { type: "turn-start" },
        { awaitAck: awaitBoundaries }
      );
    });
    recordEvent({ type: "turn-start" });
    await emitCommittedRuntimeInputs(
      events,
      run,
      committedPreUser,
      recordEvent
    );
    await drainRuntimeInput({
      attachmentStore: model.attachmentStore,
      events,
      executionHost: execution.executionHost,
      placement: "turn-start",
      recordEvent,
      run,
      runtimeInput,
      state,
      threadKey,
    });

    const result = await runAgentLoopWithOverflowCompaction({
      execution,
      model,
      runLoop: () =>
        runAgentLoop({
          emit: async (event) =>
            emitTurnEvent({
              attachmentStore: model.attachmentStore,
              event,
              events,
              executionHost: execution.executionHost,
              awaitBoundaries,
              recordEvent,
              run,
              runtimeInput,
              state,
              threadKey,
            }),
          history: state.history,
          model,
          captureObserverEvents: (callback) =>
            events.captureObserverEvents(run, callback),
          signal: activeAbort.signal,
          toolExecution: executionRun?.toolExecution,
        }),
      state,
    });

    state.clearTransientInputs();
    await commitThreadStateAndEvents({
      buffer: durableEvents,
      executionHost: execution.executionHost,
      state,
      threadKey,
    });
    await executionRun?.complete(executionStatusForResult(result));
    await closeSuccessfulTurn({
      deactivateRun,
      events,
      recordEvent,
      result,
      run,
      runtimeInput,
    });
    await flushDurableThreadEvents({
      buffer: durableEvents,
      executionHost: execution.executionHost,
      threadKey,
    });
    if (result === "completed" && input) {
      scheduleThreadAutoCompaction({
        model,
        policy: execution.autoCompaction,
        state,
      });
    }
  } catch (error) {
    if (pendingDurableInputClaim) {
      await releaseDurableThreadInputClaim({
        executionHost: execution.executionHost,
        record: pendingDurableInputClaim,
      });
      pendingDurableInputClaim = undefined;
    }
    const turnError = error instanceof Error ? error : new Error(String(error));
    await executionRun?.complete(executionStatusForError(turnError));
    await emitTurnErrorAfterRecovery({
      error: turnError,
      historySnapshot,
      run,
      runtimeInput,
      state,
    });
  } finally {
    if (pendingDurableInputClaim) {
      await releaseDurableThreadInputClaim({
        executionHost: execution.executionHost,
        record: pendingDurableInputClaim,
      });
    }
    closeRuntimeInput(runtimeInput);
    release();
    run.close();
  }
}

function executionStatusForResult(
  result: "aborted" | "completed"
): ThreadExecutionTerminalStatus {
  return result === "aborted" ? "cancelled" : "completed";
}

function executionStatusForError(error: Error): ThreadExecutionTerminalStatus {
  return error instanceof ToolExecutionNeedsRecoveryError
    ? "needs-recovery"
    : "error";
}

async function closeSuccessfulTurn({
  deactivateRun,
  events,
  recordEvent,
  result,
  run,
  runtimeInput,
}: {
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly recordEvent: (event: AgentEvent) => void;
  readonly result: "aborted" | "completed";
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
}): Promise<void> {
  const terminalEvent = result === "aborted" ? "turn-abort" : "turn-end";
  closeRuntimeInput(runtimeInput, terminalEvent);
  deactivateRun();
  try {
    const processed = await events.emitRunEvent(run, { type: terminalEvent });
    if (processed !== "handled") {
      recordEvent(processed);
    }
  } catch (terminalError) {
    run.emit({ type: "turn-error", message: errorMessage(terminalError) });
    closeRuntimeInput(runtimeInput, "turn-error");
  }
}
