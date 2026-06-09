import {
  emitRuntimeInputEvent,
  runtimeInputEventFromQueued,
} from "./runtime-input-emit";
import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  type QueuedRuntimeInput,
  shiftRuntimeInput,
} from "./runtime-input";
import type { SessionEventDispatcher } from "./session-events";
import type { SessionState } from "./session-state";
import type { BufferedAgentRun } from "./run";

export async function drainRuntimeInput({
  events,
  placement,
  run,
  runtimeInput,
  state,
}: {
  readonly events: SessionEventDispatcher;
  readonly placement: RuntimeInputPlacement;
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
  readonly state: SessionState;
}): Promise<boolean> {
  let added = false;
  let next = shiftRuntimeInput(runtimeInput, placement);
  while (next) {
    if (await emitRuntimeInputEvent(events, run, state, next)) {
      added = true;
    }
    next = shiftRuntimeInput(runtimeInput, placement);
  }

  return added;
}

export { runtimeInputEventFromQueued };