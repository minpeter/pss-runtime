import { AgentHookRuntime } from "../../agent/core/hook-runtime";
import { runAgentLoop } from "../../agent/loop/run";
import { stageUserInputAttachments } from "../input/attachments";
import {
  closeRuntimeInput,
  withRuntimeInputWindow,
} from "../input/runtime-input";
import {
  commitPreUserRuntimeInputs,
  emitCommittedRuntimeInputs,
} from "../input/runtime-input-emit";
import { scheduleThreadCompaction } from "./auto-compaction-runner";
import { drainRuntimeInput } from "./drain";
import { commitAndAckDurableThreadInput } from "./durable-input-acknowledgement";
import { releasePendingDurableThreadInputClaim } from "./durable-input-claims";
import { startThreadExecutionRun, type ThreadExecutionRun } from "./execution";
import { runAgentLoopWithOverflowCompaction } from "./loop-overflow";
import { recoverQueuedInputFailure } from "./queued-input-error-recovery";
import {
  commitThreadStateAndEvents,
  createDurableThreadEventRecorder,
} from "./thread-event-log";
import { QueuedInputRecoveryError } from "./turn-error";
import { normalizeTurnError } from "./turn-error-metadata";
import { emitTurnEvent } from "./turn-events";
import { createTurnModelTransforms } from "./turn-model-transforms";
import type { ProcessQueuedInputOptions } from "./turn-processor-options";
import { closeTurnWithDurableTerminalEvent } from "./turn-terminal";

export type QueuedInputOutcome = "processed" | "blocked";

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
}: ProcessQueuedInputOptions): Promise<QueuedInputOutcome> {
  const activeAbort = new AbortController();
  const {
    durableInputClaim,
    executionRun: queuedExecutionRun,
    awaitBoundaries = true,
    input: queuedInput,
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
  const meterCheckpoint = model.contextTokenMeter?.checkpoint();
  let executionRun: ThreadExecutionRun | undefined;
  let executionStarted = false;
  let pendingDurableInputClaim = durableInputClaim;
  const { buffer: durableEvents, record: recordEvent } =
    createDurableThreadEventRecorder();
  const { latestContextTransform, transformModelContext, transformModelStep } =
    createTurnModelTransforms({
      hookRuntime: execution.hookRuntime ?? new AgentHookRuntime(),
      state,
      threadKey,
    });
  try {
    executionRun = await startThreadExecutionRun({
      executionRun: queuedExecutionRun,
      executionHost: execution.executionHost,
      interceptToolCall: (checkpoint) =>
        events.interceptBeforeToolCall(checkpoint),
      interceptToolResult: (checkpoint) =>
        events.interceptAfterToolCall(checkpoint),
      threadKey,
      state,
      turnId,
    });
    executionStarted = true;
    if (
      !(await activateContinuation(
        item,
        state,
        executionRun,
        activeAbort.signal
      ))
    ) {
      return "processed";
    }
    resolveQueuedInputRecovery(item, state);
    await emitInitialEvents(item, events, recordEvent);
    const committedPreUser = await commitPreUserRuntimeInputs(
      events,
      state,
      item.preUserRuntimeInputs,
      model.attachmentStore,
      {
        commitRecordedEvents: () =>
          commitThreadStateAndEvents({
            buffer: durableEvents,
            executionHost: execution.executionHost,
            executionRun,
            state,
            threadKey,
          }),
        recordEvent,
      }
    );
    if (input) {
      state.appendUserInput(
        await stageUserInputAttachments(input, model.attachmentStore, {
          trustRuntimeAttachmentRefs: true,
        })
      );
      if (pendingDurableInputClaim) {
        recordEvent(item.acceptedEvent ?? input);
        await commitAndAckDurableThreadInput({
          buffer: durableEvents,
          executionHost: execution.executionHost,
          executionRun,
          record: pendingDurableInputClaim,
          state,
          threadKey,
        });
        pendingDurableInputClaim = undefined;
      } else {
        recordEvent(item.acceptedEvent ?? input);
        await commitThreadStateAndEvents({
          buffer: durableEvents,
          executionHost: execution.executionHost,
          executionRun,
          state,
          threadKey,
        });
      }
    }
    await withRuntimeInputWindow(runtimeInput, "turn-start", async () => {
      await events.emitRunBoundaryEvent(
        run,
        { type: "turn-start" },
        { awaitAck: awaitBoundaries }
      );
    });
    recordEvent({ type: "turn-start" });
    await emitCommittedRuntimeInputs(events, run, committedPreUser);
    await drainRuntimeInput({
      attachmentStore: model.attachmentStore,
      durableEvents,
      events,
      executionHost: execution.executionHost,
      executionRun,
      placement: "turn-start",
      recordEvent,
      run,
      runtimeInput,
      state,
      threadKey,
    });

    const agentLoopRuntimeState = { runtimeStepIndex: 0 };
    const result = await runAgentLoopWithOverflowCompaction({
      compact: (input, guard) => events.compact(state, input, guard),
      execution,
      latestContextTransform,
      model,
      runLoop: () =>
        runAgentLoop({
          emit: async (event) =>
            emitTurnEvent({
              attachmentStore: model.attachmentStore,
              durableEvents,
              event,
              events,
              executionHost: execution.executionHost,
              executionRun,
              awaitBoundaries,
              recordEvent,
              run,
              runtimeInput,
              state,
              threadKey,
            }),
          history: state.history,
          model,
          runtimeState: agentLoopRuntimeState,
          captureObserverEvents: (callback) =>
            events.captureObserverEvents(run, callback),
          signal: activeAbort.signal,
          threadKey,
          toolExecution: executionRun?.toolExecution,
          transformModelContext,
          transformModelStep,
        }),
      state,
      signal: activeAbort.signal,
      threadKey,
      transformModelContext,
    });

    state.clearTransientInputs();
    await closeTurnWithDurableTerminalEvent({
      buffer: durableEvents,
      deactivateRun,
      events,
      executionHost: execution.executionHost,
      executionRun,
      recordEvent,
      result,
      run,
      runtimeInput,
      state,
      threadKey,
    });
    if (result === "completed" && input) {
      scheduleThreadCompaction({
        compact: (compactionInput, guard) =>
          events.compact(state, compactionInput, guard),
        compaction: execution.compaction,
        latestContextTransform,
        model,
        state,
        threadKey,
        transformModelContext,
      });
    }
    return "processed";
  } catch (error) {
    if (!executionStarted) {
      // Start never acquired execution authority. Do not persist history or
      // terminalize a record that may already belong to another worker.
      emitStartFailure(item, error);
      return "blocked";
    }
    const blocked =
      pendingDurableInputClaim !== undefined ||
      error instanceof QueuedInputRecoveryError;
    pendingDurableInputClaim = await recoverQueuedInputFailure({
      durableEvents,
      error,
      execution,
      executionRun,
      historySnapshot,
      item,
      meterCheckpoint,
      model,
      pendingDurableInputClaim,
      recordEvent,
      state,
      threadKey,
    });
    return blocked ? "blocked" : "processed";
  } finally {
    await releasePendingDurableThreadInputClaim({
      executionHost: execution.executionHost,
      onReleased: () => {
        closeRuntimeInput(runtimeInput);
        release();
        run.close();
      },
      record: pendingDurableInputClaim,
    });
  }
}

async function activateContinuation(
  item: ProcessQueuedInputOptions["item"],
  state: ProcessQueuedInputOptions["state"],
  executionRun: ThreadExecutionRun | undefined,
  signal: AbortSignal
): Promise<boolean> {
  if (item.continuation && !signal.aborted) {
    await state.refresh();
  }
  if (
    signal.aborted ||
    (item.continuation && !state.applyContinuationCheckpoint(item.continuation))
  ) {
    await executionRun?.complete("cancelled");
    item.run.emit({ type: "turn-abort" });
    return false;
  }
  return true;
}

function emitStartFailure(
  item: ProcessQueuedInputOptions["item"],
  error: unknown
): void {
  const normalized = normalizeTurnError(error);
  item.run.emit({
    type: "turn-error",
    message: normalized.message ?? "Turn could not start.",
    ...(normalized.error === undefined ? {} : { error: normalized.error }),
  });
}

function resolveQueuedInputRecovery(
  item: ProcessQueuedInputOptions["item"],
  state: ProcessQueuedInputOptions["state"]
): void {
  if (item.continuation) {
    return;
  }
  const checkpoint = state.continuationCheckpoint();
  if (checkpoint?.recover) {
    // Recovery is deliberately evaluated at execution time, after the run has
    // authority. A throwing recovery closure fences every canonical route,
    // while a resolved closure supplies the repaired history before input is
    // appended or runtime notification inputs are emitted.
    try {
      state.rollback(checkpoint.recover());
      state.clearContinuationCheckpoint();
    } catch (error) {
      throw new QueuedInputRecoveryError(error, checkpoint);
    }
  }
  if (item.input || item.durableInputClaim) {
    state.clearContinuationCheckpoint();
  }
}

async function emitInitialEvents(
  item: ProcessQueuedInputOptions["item"],
  events: ProcessQueuedInputOptions["events"],
  recordEvent: (event: import("../protocol/events").AgentEvent) => void
): Promise<void> {
  for (const event of item.initialEvents) {
    const processed = await events.emitRunEvent(item.run, event);
    if (processed !== "handled") {
      recordEvent(processed);
    }
  }
}
