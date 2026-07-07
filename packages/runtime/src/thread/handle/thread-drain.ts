import type { ModelGenerationOptions } from "../../llm/llm";
import type { QueuedInput, RuntimeInputState } from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadEventDispatcher } from "../runtime/events";
import type { ThreadExecutionOptions } from "../runtime/execution";
import { processQueuedInput } from "../runtime/turn-processor";
import type { ThreadState } from "../state/thread-state";
import {
  claimOrphanDurableThreadInput,
  prepareQueuedDurableInput,
} from "./durable-queue";

interface ActiveTurn {
  readonly abort: AbortController;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly turnId: string;
}

export interface ThreadInputDrainLoopOptions {
  readonly activate: (turn: ActiveTurn) => void;
  readonly claimRecoveredDurableInput: boolean;
  readonly continueDraining: () => boolean;
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly execution: ThreadExecutionOptions;
  readonly inputQueue: QueuedInput[];
  readonly model: ModelGenerationOptions;
  readonly release: () => void;
  readonly state: ThreadState;
  readonly threadKey: string;
}

export async function runThreadInputDrainLoop({
  activate,
  claimRecoveredDurableInput,
  continueDraining,
  deactivateRun,
  events,
  execution,
  inputQueue,
  model,
  release,
  state,
  threadKey,
}: ThreadInputDrainLoopOptions): Promise<void> {
  let claimOrphanDurableInput =
    inputQueue.length === 0 || claimRecoveredDurableInput;
  while (continueDraining()) {
    const queuedInput = inputQueue.shift();
    if (queuedInput) {
      const item = await prepareQueuedDurableInput({
        executionHost: execution.executionHost,
        item: queuedInput,
        threadKey,
      });
      if (!item) {
        continue;
      }

      await processInput(item);
      continue;
    }

    if (!claimOrphanDurableInput) {
      break;
    }

    claimOrphanDurableInput = false;
    const item = await claimOrphanDurableThreadInput({
      executionHost: execution.executionHost,
      threadKey,
    });
    if (!item) {
      break;
    }

    await processInput(item);
    claimOrphanDurableInput = true;
  }

  async function processInput(item: QueuedInput): Promise<void> {
    await processQueuedInput({
      activate,
      deactivateRun,
      events,
      execution,
      item,
      model,
      release,
      state,
      threadKey,
    });
  }
}
