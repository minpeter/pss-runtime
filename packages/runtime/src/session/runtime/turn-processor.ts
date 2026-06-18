import { runAgentLoop } from "../../agent/loop/loop";
import type { ModelGenerationOptions } from "../../llm/llm";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution";
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
import type { BufferedAgentRun } from "../protocol/run";
import { errorMessage } from "../state/session-errors";
import type { SessionState } from "../state/session-state";
import { drainRuntimeInput } from "./drain";
import type { SessionEventDispatcher } from "./events";
import {
  type SessionExecutionOptions,
  type SessionExecutionRun,
  type SessionExecutionTerminalStatus,
  startSessionExecutionRun,
} from "./execution";
import { emitTurnErrorAfterRecovery } from "./turn-error";

interface ActiveTurn {
  readonly abort: AbortController;
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
  readonly turnId: string;
}

interface ProcessQueuedInputOptions {
  readonly activate: (turn: ActiveTurn) => void;
  readonly deactivateRun: () => void;
  readonly events: SessionEventDispatcher;
  readonly execution: SessionExecutionOptions;
  readonly item: QueuedInput;
  readonly model: ModelGenerationOptions;
  readonly release: () => void;
  readonly state: SessionState;
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
  const { initialEvents, input, preUserRuntimeInputs, run, runtimeInput } =
    item;
  const turnId = crypto.randomUUID();
  activate({
    abort: activeAbort,
    run,
    runtimeInput,
    turnId,
  });
  const historySnapshot = state.modelSnapshot();
  let executionRun: SessionExecutionRun | undefined;

  try {
    executionRun = await startSessionExecutionRun({
      executionHost: execution.executionHost,
      threadKey,
      state,
      turnId,
    });
    for (const event of initialEvents) {
      await events.emitRunEvent(run, event);
    }
    const committedPreUser = await commitPreUserRuntimeInputs(
      events,
      state,
      preUserRuntimeInputs
    );
    if (input) {
      state.appendUserInput(input);
      await state.commit();
    }
    await withRuntimeInputWindow(runtimeInput, "turn-start", async () => {
      await events.emitRunBoundaryEvent(run, { type: "turn-start" });
    });
    await emitCommittedRuntimeInputs(events, run, committedPreUser);
    await drainRuntimeInput({
      events,
      placement: "turn-start",
      run,
      runtimeInput,
      state,
    });

    const result = await runAgentLoop({
      emit: async (event) =>
        emitTurnEvent({
          event,
          events,
          run,
          runtimeInput,
          state,
        }),
      history: state.history,
      model,
      captureObserverEvents: (callback) =>
        events.captureObserverEvents(run, callback),
      signal: activeAbort.signal,
      toolExecution: executionRun?.toolExecution,
    });

    await state.commit();
    await executionRun?.complete(executionStatusForResult(result));
    await closeSuccessfulTurn({
      deactivateRun,
      events,
      result,
      run,
      runtimeInput,
    });
  } catch (error) {
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
    closeRuntimeInput(runtimeInput);
    release();
    run.close();
  }
}

function executionStatusForResult(
  result: "aborted" | "completed"
): SessionExecutionTerminalStatus {
  return result === "aborted" ? "cancelled" : "completed";
}

function executionStatusForError(error: Error): SessionExecutionTerminalStatus {
  return error instanceof ToolExecutionNeedsRecoveryError
    ? "needs-recovery"
    : "error";
}

async function closeSuccessfulTurn({
  deactivateRun,
  events,
  result,
  run,
  runtimeInput,
}: {
  readonly deactivateRun: () => void;
  readonly events: SessionEventDispatcher;
  readonly result: "aborted" | "completed";
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
}): Promise<void> {
  const terminalEvent = result === "aborted" ? "turn-abort" : "turn-end";
  closeRuntimeInput(runtimeInput, terminalEvent);
  deactivateRun();
  try {
    await events.emitRunEvent(run, { type: terminalEvent });
  } catch (terminalError) {
    run.emit({ type: "turn-error", message: errorMessage(terminalError) });
    closeRuntimeInput(runtimeInput, "turn-error");
  }
}

async function emitTurnEvent({
  event,
  events,
  run,
  runtimeInput,
  state,
}: {
  readonly event: AgentEvent;
  readonly events: SessionEventDispatcher;
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
  readonly state: SessionState;
}): Promise<{ readonly runtimeInputAdded: boolean } | undefined> {
  if (event.type !== "step-start" && event.type !== "step-end") {
    await events.emitRunEvent(run, event);
    return;
  }

  await withRuntimeInputWindow(runtimeInput, event.type, async () => {
    await events.emitRunBoundaryEvent(run, event);
  });
  const runtimeInputAdded = await drainRuntimeInput({
    events,
    placement: event.type,
    run,
    runtimeInput,
    state,
  });
  return event.type === "step-end" ? { runtimeInputAdded } : undefined;
}
