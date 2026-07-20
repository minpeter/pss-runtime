import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import type { AgentHost } from "../../execution/host/types";
import {
  createRuntimeInputState,
  type QueuedInput,
} from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import {
  claimDurableThreadInput,
  recoverDurableThreadInputs,
} from "../runtime/durable-input-claims";
import {
  cancelThreadExecutionRun,
  precreateThreadExecutionRun,
} from "../runtime/execution";

export class DurableInputRecoveryState {
  recoveredInputClaims = false;
}

export async function recoverThreadDurableInputClaims({
  executionHost,
  state,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly state: DurableInputRecoveryState;
  readonly threadKey: string;
}): Promise<void> {
  if (state.recoveredInputClaims) {
    return;
  }

  state.recoveredInputClaims = true;
  try {
    await recoverDurableThreadInputs({
      executionHost,
      threadKey,
    });
  } catch (error) {
    state.recoveredInputClaims = false;
    throw error;
  }
}

export async function claimOrphanDurableThreadInput({
  executionHost,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly threadKey: string;
}): Promise<QueuedInput | undefined> {
  const claimed = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost,
    threadKey,
  });
  if (claimed.kind === "unavailable" || !claimed.record) {
    return;
  }

  const runId = createThreadExecutionRunId({
    threadKey: claimed.record.threadKey,
    turnId: claimed.record.messageId,
  });
  const precreated = await precreateThreadExecutionRun({
    executionHost,
    kind: "user-turn",
    runId,
    threadKey,
  });
  return {
    acceptedEvent: claimed.record.input,
    awaitBoundaries: false,
    durableInputClaim: claimed.record,
    ...(precreated
      ? { executionRun: { kind: precreated.kind, runId: precreated.runId } }
      : {}),
    initialEvents: [],
    preUserRuntimeInputs: [],
    run: new BufferedAgentTurn(precreated?.runId),
    runtimeInput: createRuntimeInputState([]),
  };
}

export async function prepareQueuedDurableInput({
  executionHost,
  item,
  threadKey,
}: {
  readonly executionHost: AgentHost | undefined;
  readonly item: QueuedInput;
  readonly threadKey: string;
}): Promise<QueuedInput | undefined> {
  if (!item.durableInput) {
    return item;
  }

  const claimed = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost,
    messageId: item.durableMessageId,
    threadKey,
  });
  if (claimed.kind === "claimed" && claimed.record) {
    return { ...item, durableInputClaim: claimed.record };
  }

  await cancelThreadExecutionRun({
    executionHost,
    executionRun: item.executionRun,
  });
  item.run.close();
  return;
}
