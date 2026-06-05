import {
  closeRuntimeInput,
  type QueuedInput,
  type RuntimeInputState,
} from "./runtime-input";

interface CloseKilledRuntimeInputsOptions {
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly inputQueue: QueuedInput[];
  readonly message: string;
}

export function closeKilledRuntimeInputs({
  activeRuntimeInput,
  inputQueue,
  message,
}: CloseKilledRuntimeInputsOptions): void {
  closeRuntimeInput(activeRuntimeInput, message);

  while (inputQueue.length > 0) {
    const item = inputQueue.shift();
    closeRuntimeInput(item?.runtimeInput, message);
    item?.run.emit({ type: "turn-error", message });
    item?.run.close(undefined, message);
  }
}
