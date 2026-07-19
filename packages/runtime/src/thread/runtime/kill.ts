import type { AgentHost } from "../../execution/host/types";
import {
  closeRuntimeInput,
  type QueuedInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import { cancelQueuedDurableThreadInputs } from "./durable-input-cancellation";
import { cancelThreadExecutionRun } from "./execution";

interface CloseKilledRuntimeInputsOptions {
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly executionHost: AgentHost | undefined;
  readonly inputQueue: QueuedInput[];
  readonly message: string;
  readonly runToClose: BufferedAgentTurn | undefined;
  readonly threadKey: string;
}

export async function closeKilledRuntimeInputs({
  activeRuntimeInput,
  executionHost,
  inputQueue,
  message,
  runToClose,
  threadKey,
}: CloseKilledRuntimeInputsOptions): Promise<void> {
  closeRuntimeInput(activeRuntimeInput, message);
  runToClose?.emit({ type: "turn-error", message });
  runToClose?.close();

  const queuedItems: QueuedInput[] = [];
  while (inputQueue.length > 0) {
    const item = inputQueue.shift();
    closeRuntimeInput(item?.runtimeInput, message);
    item?.run.emit({ type: "turn-error", message });
    item?.run.close();
    if (item) {
      queuedItems.push(item);
    }
  }

  const nonDurableRuns = queuedItems.filter(
    (item) => item.durableMessageId === undefined
  );
  await Promise.all([
    cancelQueuedDurableThreadInputs({
      executionHost,
      items: queuedItems,
      threadKey,
    }),
    cancelThreadExecutionRun({
      executionHost,
      runId: runToClose?.runId,
    }),
    ...nonDurableRuns.map((item) =>
      cancelThreadExecutionRun({
        executionHost,
        executionRun: item.executionRun,
      })
    ),
  ]);
}
