import type { BufferedAgentRun } from "./run";
import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "./runtime-input";
import type { SessionState } from "./session-state";

export async function drainRuntimeInput({
  placement,
  run,
  runtimeInput,
  state,
}: {
  readonly placement: RuntimeInputPlacement;
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
  readonly state: SessionState;
}): Promise<boolean> {
  let added = false;
  let next = shiftRuntimeInput(runtimeInput, placement);
  while (next) {
    added = true;
    run.emit({ type: "runtime-input", input: next.input, placement });
    state.appendUserInput(next.input);
    await state.commit();
    next = shiftRuntimeInput(runtimeInput, placement);
  }

  return added;
}
