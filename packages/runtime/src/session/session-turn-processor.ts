import { runAgentLoop } from "../agent-loop";
import type { RuntimeLlm } from "../llm";
import { ToolExecutionNeedsRecoveryError } from "../llm-tool-execution";
import type { AgentEvent } from "./events";
import type { BufferedAgentRun } from "./run";
import {
  closeRuntimeInput,
  type QueuedInput,
  type QueuedRuntimeInput,
  type RuntimeInputState,
  withRuntimeInputWindow,
} from "./runtime-input";
import { errorMessage } from "./session-errors";
import type { SessionEventDispatcher } from "./session-events";
import {
  type SessionExecutionOptions,
  type SessionExecutionRun,
  type SessionExecutionTerminalStatus,
  startSessionExecutionRun,
} from "./session-execution";
import { drainRuntimeInput } from "./session-runtime-drain";
import type { SessionState } from "./session-state";
import { emitTurnErrorAfterRecovery } from "./session-turn-error";

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
  readonly llm: RuntimeLlm;
  readonly release: () => void;
  readonly sessionKey: string;
  readonly state: SessionState;
}

export async function processQueuedInput({
  activate,
  deactivateRun,
  events,
  execution,
  item,
  llm,
  release,
  sessionKey,
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
      sessionKey,
      state,
      turnId,
    });
    for (const event of initialEvents) {
      await events.emitRunEvent(run, event);
    }
    await appendRuntimeInputsToHistory(state, preUserRuntimeInputs);
    if (input) {
      state.appendUserInput(input);
      await state.commit();
    }
    await withRuntimeInputWindow(runtimeInput, "turn-start", async () => {
      await events.emitRunBoundaryEvent(run, { type: "turn-start" });
    });
    await emitPreUserRuntimeInputs(events, run, preUserRuntimeInputs);
    await drainRuntimeInput({
      emit: (event) =>
        events.emitRunEvent(run, event).then(() => undefined),
      placement: "turn-start",
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
      llm,
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
    run.close(undefined, runtimeInput.closedReason);
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

async function appendRuntimeInputsToHistory(
  state: SessionState,
  runtimeInputs: readonly QueuedRuntimeInput[]
): Promise<void> {
  for (const runtimeInput of runtimeInputs) {
    state.appendUserInput(runtimeInput.input);
    await state.commit();
  }
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

async function emitPreUserRuntimeInputs(
  events: SessionEventDispatcher,
  run: BufferedAgentRun,
  runtimeInputs: readonly QueuedRuntimeInput[]
): Promise<void> {
  for (const runtimeInput of runtimeInputs) {
    await events.emitRunEvent(run, {
      input: runtimeInput.input,
      placement: runtimeInput.placement,
      type: "runtime-input",
    });
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
    emit: (runtimeInputEvent) =>
      events.emitRunEvent(run, runtimeInputEvent).then(() => undefined),
    placement: event.type,
    runtimeInput,
    state,
  });
  return event.type === "step-end" ? { runtimeInputAdded } : undefined;
}
