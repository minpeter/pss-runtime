import type { BufferedAgentRun } from "./run";
import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "./runtime-input";
import { emitRuntimeInputEvent } from "./runtime-input-emit";
import type { SessionEventDispatcher } from "./session-events";
import type { SessionState } from "./session-state";

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
