import {
  closeRuntimeInput,
  type QueuedInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";

interface CloseKilledRuntimeInputsOptions {
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly inputQueue: QueuedInput[];
  readonly message: string;
  readonly runToClose: BufferedAgentTurn | undefined;
}

export function closeKilledRuntimeInputs({
  activeRuntimeInput,
  inputQueue,
  message,
  runToClose,
}: CloseKilledRuntimeInputsOptions): void {
  closeRuntimeInput(activeRuntimeInput, message);
  runToClose?.emit({ type: "turn-error", message });
  runToClose?.close();

  while (inputQueue.length > 0) {
    const item = inputQueue.shift();
    closeRuntimeInput(item?.runtimeInput, message);
    item?.run.emit({ type: "turn-error", message });
    item?.run.close();
  }
}
