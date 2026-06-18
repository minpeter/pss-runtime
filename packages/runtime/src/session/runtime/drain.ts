import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "../input/runtime-input";
import { emitRuntimeInputEvent } from "../input/runtime-input-emit";
import type { BufferedAgentRun } from "../protocol/run";
import type { SessionState } from "../state/session-state";
import type { SessionEventDispatcher } from "./events";

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
