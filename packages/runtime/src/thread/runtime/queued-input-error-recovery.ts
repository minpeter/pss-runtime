import type { ModelMessage } from "ai";
import { restoreContextTokenMeter } from "./context-token-meter-rollback";
import { releasePendingDurableThreadInputClaim } from "./durable-input-claims";
import type { ThreadExecutionRun } from "./execution";
import type { QueuedInputOutcome } from "./queued-input-processor";
import type { DurableThreadEventBuffer } from "./thread-event-log";
import {
  QueuedInputRecoveryError,
  recoverTurnProcessingError,
} from "./turn-error";
import { abandonLostTurn, turnOwnershipLoss } from "./turn-ownership";
import type { ProcessQueuedInputOptions } from "./turn-processor-options";

/**
 * Ends a started turn that failed. A turn whose run another owner took over
 * writes nothing; any other failure goes through turn-error recovery. Later
 * queued input still runs: its runs are separate, and thread commits stay
 * version-checked against the other owner's.
 */
export async function settleFailedTurn(
  options: Parameters<typeof recoverQueuedInputFailure>[0] & {
    readonly signal: AbortSignal;
  }
): Promise<{
  readonly outcome: QueuedInputOutcome;
  readonly pendingDurableInputClaim: ProcessQueuedInputOptions["item"]["durableInputClaim"];
}> {
  const loss = turnOwnershipLoss(
    options.error,
    options.signal,
    options.executionRun?.runId
  );
  if (loss) {
    await abandonLostTurn({
      item: options.item,
      loss,
      meterCheckpoint: options.meterCheckpoint,
      model: options.model,
      state: options.state,
    });
    return {
      outcome: "processed",
      pendingDurableInputClaim: options.pendingDurableInputClaim,
    };
  }
  const blocked =
    options.pendingDurableInputClaim !== undefined ||
    options.error instanceof QueuedInputRecoveryError;
  return {
    outcome: blocked ? "blocked" : "processed",
    pendingDurableInputClaim: await recoverQueuedInputFailure(options),
  };
}

export async function recoverQueuedInputFailure({
  durableEvents,
  error,
  execution,
  executionRun,
  historySnapshot,
  item,
  meterCheckpoint,
  model,
  pendingDurableInputClaim,
  recordEvent,
  state,
  threadKey,
}: {
  readonly durableEvents: DurableThreadEventBuffer;
  readonly error: unknown;
  readonly execution: ProcessQueuedInputOptions["execution"];
  readonly executionRun?: ThreadExecutionRun;
  readonly historySnapshot: ModelMessage[];
  readonly item: ProcessQueuedInputOptions["item"];
  readonly meterCheckpoint:
    | ReturnType<
        NonNullable<
          ProcessQueuedInputOptions["model"]["contextTokenMeter"]
        >["checkpoint"]
      >
    | undefined;
  readonly model: ProcessQueuedInputOptions["model"];
  readonly pendingDurableInputClaim: ProcessQueuedInputOptions["item"]["durableInputClaim"];
  readonly recordEvent: Parameters<
    typeof recoverTurnProcessingError
  >[0]["recordEvent"];
  readonly state: ProcessQueuedInputOptions["state"];
  readonly threadKey: string;
}): Promise<ProcessQueuedInputOptions["item"]["durableInputClaim"]> {
  const pendingClaim = await releasePendingDurableThreadInputClaim({
    executionHost: execution.executionHost,
    record: pendingDurableInputClaim,
  });
  restoreContextTokenMeter(model.contextTokenMeter, meterCheckpoint, item.run);
  try {
    await recoverTurnProcessingError({
      durableEvents,
      error,
      executionHost: execution.executionHost,
      executionRun,
      historySnapshot,
      recordEvent,
      run: item.run,
      runtimeInput: item.runtimeInput,
      state,
      threadKey,
    });
  } catch (recoveryError) {
    if (item.executionRun?.kind === "notification") {
      item.run.closeWithError(recoveryError);
    }
    throw recoveryError;
  }
  return pendingClaim;
}
