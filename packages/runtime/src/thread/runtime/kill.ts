import type { ExecutionHost } from "../../execution/host/types";
import {
  closeRuntimeInput,
  type QueuedInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import { cancelThreadExecutionRun } from "./execution";

interface CloseKilledRuntimeInputsOptions {
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly executionHost: ExecutionHost | undefined;
  readonly inputQueue: QueuedInput[];
  readonly message: string;
  readonly runToClose: BufferedAgentTurn | undefined;
}

export async function closeKilledRuntimeInputs({
  activeRuntimeInput,
  executionHost,
  inputQueue,
  message,
  runToClose,
}: CloseKilledRuntimeInputsOptions): Promise<void> {
  closeRuntimeInput(activeRuntimeInput, message);
  runToClose?.emit({ type: "turn-error", message });

  const queuedClosures: Promise<void>[] = [];
  while (inputQueue.length > 0) {
    const item = inputQueue.shift();
    closeRuntimeInput(item?.runtimeInput, message);
    item?.run.emit({ type: "turn-error", message });
    if (item) {
      queuedClosures.push(closeKilledQueuedInput({ executionHost, item }));
    }
  }

  await Promise.all([
    closeKilledTurn({ executionHost, run: runToClose }),
    ...queuedClosures,
  ]);
}

async function closeKilledQueuedInput({
  executionHost,
  item,
}: {
  readonly executionHost: ExecutionHost | undefined;
  readonly item: QueuedInput;
}): Promise<void> {
  await closeKilledTurn({
    executionHost,
    run: item.run,
    runId: item.executionRun?.runId,
  });
}

async function closeKilledTurn({
  executionHost,
  run,
  runId = run?.runId,
}: {
  readonly executionHost: ExecutionHost | undefined;
  readonly run: BufferedAgentTurn | undefined;
  readonly runId?: string;
}): Promise<void> {
  if (!run) {
    return;
  }

  try {
    await cancelThreadExecutionRun({
      executionHost,
      runId,
    });
  } finally {
    run.close();
  }
}
