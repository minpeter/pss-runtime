import type { ExecutionHost } from "../../execution/host/types";
import {
  closeRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import { errorMessage } from "../state/thread-errors";
import type { ThreadState } from "../state/thread-state";
import type { ThreadEventDispatcher } from "./events";
import {
  commitThreadStateAndEvents,
  type DurableThreadEventBuffer,
} from "./thread-event-log";

export async function closeTurnWithDurableTerminalEvent({
  buffer,
  completeExecution,
  deactivateRun,
  events,
  executionHost,
  recordEvent,
  result,
  run,
  runtimeInput,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly completeExecution: () => Promise<void>;
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: ExecutionHost;
  readonly recordEvent: (event: AgentEvent) => void;
  readonly result: "aborted" | "completed";
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const terminalEvent = terminalEventForResult(result);
  closeRuntimeInput(runtimeInput, terminalEvent.type);
  deactivateRun();
  try {
    await events.observeRunEvent(terminalEvent);
  } catch (terminalError) {
    await closeWithTerminalError({
      buffer,
      completeExecution,
      error: terminalError,
      executionHost,
      recordEvent,
      run,
      runtimeInput,
      state,
      threadKey,
    });
    return;
  }

  recordEvent(terminalEvent);
  await commitThreadStateAndEvents({
    buffer,
    executionHost,
    state,
    threadKey,
  });
  await completeExecution();
  events.emitProcessedEvent(run, terminalEvent);
}

async function closeWithTerminalError({
  buffer,
  completeExecution,
  error,
  executionHost,
  recordEvent,
  run,
  runtimeInput,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly completeExecution: () => Promise<void>;
  readonly error: unknown;
  readonly executionHost?: ExecutionHost;
  readonly recordEvent: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const event: AgentEvent = {
    message: errorMessage(error),
    type: "turn-error",
  };
  recordEvent(event);
  await commitThreadStateAndEvents({
    buffer,
    executionHost,
    state,
    threadKey,
  });
  await completeExecution();
  run.emit(event);
  closeRuntimeInput(runtimeInput, "turn-error");
}

function terminalEventForResult(result: "aborted" | "completed"): AgentEvent {
  return { type: result === "aborted" ? "turn-abort" : "turn-end" };
}
