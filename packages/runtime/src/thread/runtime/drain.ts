import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "../input/runtime-input";
import { emitRuntimeInputEvent } from "../input/runtime-input-emit";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadState } from "../state/thread-state";
import type { ThreadEventDispatcher } from "./events";

export async function drainRuntimeInput({
  events,
  placement,
  run,
  runtimeInput,
  state,
}: {
  readonly events: ThreadEventDispatcher;
  readonly placement: RuntimeInputPlacement;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
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
