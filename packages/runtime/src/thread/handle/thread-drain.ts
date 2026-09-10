import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { QueuedInput, RuntimeInputState } from "../input/runtime-input";
import { closeRuntimeInput } from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadExecutionOptions } from "../runtime/execution";
import {
  cancellationForExecutionRun,
  cancelThreadExecutionRun,
} from "../runtime/execution";
import { unregisterLiveThreadInput } from "../runtime/live-input-ownership";
import {
  processQueuedInput,
  type QueuedInputOutcome,
} from "../runtime/queued-input-processor";
import type { ThreadEventDispatcher } from "../runtime/thread-event-dispatcher";
import type { ThreadState } from "../state/thread-state";
import {
  claimOrphanDurableThreadInput,
  prepareQueuedDurableInput,
} from "./durable-queue-claims";

interface ActiveTurn {
  readonly abort: AbortController;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly turnId: string;
}

export interface ThreadInputDrainLoopOptions {
  readonly activate: (turn: ActiveTurn) => void;
  readonly continueDraining: () => boolean;
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly execution: ThreadExecutionOptions;
  readonly inputQueue: QueuedInput[];
  readonly model: ModelGenerationOptions;
  readonly onBlocked?: (released: Promise<void>) => void;
  readonly release: () => void;
  readonly state: ThreadState;
  readonly threadKey: string;
}

export async function runThreadInputDrainLoop({
  activate,
  continueDraining,
  deactivateRun,
  events,
  execution,
  inputQueue,
  model,
  onBlocked,
  release,
  state,
  threadKey,
}: ThreadInputDrainLoopOptions): Promise<void> {
  let claimOrphanDurableInput = true;
  while (continueDraining()) {
    const queuedInput = inputQueue[0];
    if (queuedInput) {
      const preparation = await prepareQueuedDurableInput({
        executionHost: execution.executionHost,
        item: queuedInput,
        threadKey,
      });
      switch (preparation.kind) {
        case "superseded":
          inputQueue.shift();
          state.clearContinuationCheckpoint();
          await cancelSupersededContinuation(queuedInput, execution);
          continue;
        case "blocked":
          onBlocked?.(preparation.released);
          return;
        case "unavailable":
          inputQueue.shift();
          continue;
        case "prepared":
          inputQueue.shift();
          break;
        default:
          break;
      }

      const outcome = await processInput(preparation.item);
      if (outcome === "start-failed") {
        // Later callers still own pending work. No recovery authority was
        // acquired, so retain their queue entries and event channels.
        break;
      }
      if (outcome === "blocked") {
        await parkQueuedInputs(inputQueue, execution, threadKey);
        break;
      }
      claimOrphanDurableInput &&= !isPreparedFollowUp(
        preparation.kind,
        queuedInput
      );
      continue;
    }

    if (orphanDrainBlocked(claimOrphanDurableInput, state)) {
      // A failed recovery is an authority boundary, not a transient empty
      // queue. Leave durable input pending for explicit reconciliation rather
      // than repeatedly claiming and releasing it on every drain restart.
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

    const outcome = await processInput(item);
    if (outcome !== "processed") {
      break;
    }
    claimOrphanDurableInput = true;
  }

  async function processInput(item: QueuedInput): Promise<QueuedInputOutcome> {
    return await processQueuedInput({
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

function orphanDrainBlocked(claimOrphan: boolean, state: ThreadState): boolean {
  return !claimOrphan || state.continuationCheckpoint()?.recover !== undefined;
}

async function parkQueuedInputs(
  inputQueue: QueuedInput[],
  execution: ThreadExecutionOptions,
  threadKey: string
): Promise<void> {
  const errors: unknown[] = [];
  for (const item of inputQueue.splice(0)) {
    try {
      await cancelThreadExecutionRun({
        cancellation: cancellationForExecutionRun(item.executionRun),
        executionHost: execution.executionHost,
      });
    } catch (error) {
      errors.push(error);
    } finally {
      if (item.durableMessageId) {
        unregisterLiveThreadInput(
          execution.executionHost,
          threadKey,
          item.durableMessageId,
          item.durableOwner
        );
      }
      closeRuntimeInput(item.runtimeInput);
      item.run.emit({
        type: "turn-error",
        message:
          "Task requires recovery. Reconcile pending input before starting new work.",
      });
      item.run.close();
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Queued input recovery failed.");
  }
}

async function cancelSupersededContinuation(
  item: QueuedInput,
  execution: ThreadExecutionOptions
): Promise<void> {
  try {
    await cancelThreadExecutionRun({
      cancellation: cancellationForExecutionRun(item.executionRun),
      executionHost: execution.executionHost,
    });
    item.run.emit({ type: "turn-abort" });
  } catch (error) {
    item.run.emit({
      type: "turn-error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    closeRuntimeInput(item.runtimeInput);
    item.run.close();
  }
}

function isPreparedFollowUp(kind: string, item: QueuedInput): boolean {
  return kind === "prepared" && item.durableInputKind === "follow-up";
}
