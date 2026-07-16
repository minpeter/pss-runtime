import type { AgentHost } from "../../execution/host/types";
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
  readonly completeExecution: (
    status: "cancelled" | "completed" | "error"
  ) => Promise<void>;
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: AgentHost;
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
      events,
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
  await completeExecution(result === "aborted" ? "cancelled" : "completed");
  events.emitProcessedEvent(run, terminalEvent);
}

async function closeWithTerminalError({
  buffer,
  completeExecution,
  error,
  events,
  executionHost,
  recordEvent,
  run,
  runtimeInput,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly completeExecution: (
    status: "cancelled" | "completed" | "error"
  ) => Promise<void>;
  readonly error: unknown;
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: AgentHost;
  readonly recordEvent: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  let event: AgentEvent = {
    message: errorMessage(error),
    type: "turn-error",
  };
  try {
    await events.observeRunEvent(event);
  } catch (hookError) {
    event = {
      message: `${event.message}; turn.error plugin failed: ${errorMessage(hookError)}`,
      type: "turn-error",
    };
  }
  recordEvent(event);
  await commitThreadStateAndEvents({
    buffer,
    executionHost,
    state,
    threadKey,
  });
  await completeExecution("error");
  run.emit(event);
  closeRuntimeInput(runtimeInput, "turn-error");
}

function terminalEventForResult(result: "aborted" | "completed"): AgentEvent {
  return { type: result === "aborted" ? "turn-abort" : "turn-end" };
}
