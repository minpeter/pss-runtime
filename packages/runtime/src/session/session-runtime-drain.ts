import type { RuntimeInput } from "./events";
import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "./runtime-input";
import type { SessionState } from "./session-state";

export async function drainRuntimeInput({
  emit,
  placement,
  runtimeInput,
  state,
}: {
  readonly emit: (event: RuntimeInput) => Promise<void>;
  readonly placement: RuntimeInputPlacement;
  readonly runtimeInput: RuntimeInputState;
  readonly state: SessionState;
}): Promise<boolean> {
  let added = false;
  let next = shiftRuntimeInput(runtimeInput, placement);
  while (next) {
    added = true;
    await emit({ type: "runtime-input", input: next.input, placement });
    state.appendUserInput(next.input);
    await state.commit();
    next = shiftRuntimeInput(runtimeInput, placement);
  }

  return added;
}
