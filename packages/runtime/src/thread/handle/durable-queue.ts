import type { ExecutionHost } from "../../execution/host/types";
import type { AgentInput } from "../input/input";
import { attachInputMeta, userInputFromEvent } from "../input/input-meta";
import { normalizeAgentInput } from "../input/input-normalization";
import {
  assertRuntimeInputOpen,
  createRuntimeInputState,
  currentSteeringPlacement,
  type QueuedInput,
  type QueuedRuntimeInput,
  queueRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import { BufferedAgentTurn } from "../protocol/turn";
import {
  admitDurableThreadInput,
  claimDurableThreadInput,
  recoverDurableThreadInputs,
} from "../runtime/durable-inputs";
import type { ThreadEventDispatcher } from "../runtime/events";
import { startThreadQueueDrain } from "../runtime/notification";

export class DurableInputRecoveryState {
  recoveredInputClaims = false;
}

export async function admitThreadSendInput({
  awaitBoundaries,
  drain,
  events,
  executionHost,
  input,
  inputQueue,
  pendingOverlays,
  pendingRuntimeInputs,
  run,
  threadKey,
}: {
  readonly awaitBoundaries: boolean;
  readonly drain: () => Promise<void>;
  readonly events: ThreadEventDispatcher;
  readonly executionHost: ExecutionHost | undefined;
  readonly input: AgentInput;
  readonly inputQueue: QueuedInput[];
  readonly pendingOverlays: QueuedRuntimeInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
  readonly run: BufferedAgentTurn;
  readonly threadKey: string;
}): Promise<void> {
  const queued = await createQueuedSendInput({
    awaitBoundaries,
    events,
    executionHost,
    input,
    pendingOverlays,
    pendingRuntimeInputs,
    run,
    threadKey,
  });
  if (queued.kind === "handled") {
    return;
  }

  events.emitProcessedEvent(run, queued.processed);
  inputQueue.push(queued.item);
  startThreadQueueDrain(run, drain);
}

export async function recoverThreadDurableInputClaims({
  executionHost,
  state,
  threadKey,
}: {
  readonly executionHost: ExecutionHost | undefined;
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

type QueuedSendInputResult =
  | {
      readonly kind: "queued";
      readonly item: QueuedInput;
      readonly processed: AgentEvent;
    }
  | { readonly kind: "handled" };

export async function createQueuedSendInput({
  awaitBoundaries,
  events,
  executionHost,
  input,
  pendingOverlays,
  pendingRuntimeInputs,
  run,
  threadKey,
}: {
  readonly awaitBoundaries: boolean;
  readonly events: ThreadEventDispatcher;
  readonly executionHost: ExecutionHost | undefined;
  readonly input: AgentInput;
  readonly pendingOverlays: QueuedRuntimeInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
  readonly run: BufferedAgentTurn;
  readonly threadKey: string;
}): Promise<QueuedSendInputResult> {
  const normalized = normalizeAgentInput(input);
  const acceptedInput =
    normalized.meta === undefined
      ? attachInputMeta(normalized, { source: "send" })
      : normalized;
  const processed = await events.interceptEvent(acceptedInput);
  if (processed === "handled") {
    run.close();
    return { kind: "handled" };
  }

  const queuedInput = userInputFromEvent(
    processed.type === "user-input" ? processed : acceptedInput
  );
  const admission = await admitDurableThreadInput({
    executionHost,
    input: queuedInput,
    kind: "send",
    threadKey,
  });
  if (admission.kind === "admitted" && admission.receipt.duplicate) {
    run.close();
    return { kind: "handled" };
  }

  const item = {
    awaitBoundaries,
    durableInput: admission.kind === "admitted",
    ...(admission.kind === "admitted"
      ? { durableMessageId: admission.receipt.record.messageId }
      : {}),
    initialEvents: [],
    ...(admission.kind === "unavailable"
      ? { input: structuredClone(queuedInput) }
      : {}),
    preUserRuntimeInputs: pendingOverlays.splice(0),
    run,
    runtimeInput: createRuntimeInputState(pendingRuntimeInputs.splice(0)),
  } satisfies QueuedInput;
  return { kind: "queued", item, processed };
}

export async function addDurableSteeringInput({
  executionHost,
  input,
  runtimeInput,
  threadKey,
}: {
  readonly executionHost: ExecutionHost | undefined;
  readonly input: AgentInput;
  readonly runtimeInput: RuntimeInputState;
  readonly threadKey: string;
}): Promise<void> {
  const next = runtimeInput.pending.then(async () => {
    assertRuntimeInputOpen(runtimeInput);
    const acceptedInput = attachInputMeta(normalizeAgentInput(input), {
      source: "steer",
      streaming: "steer",
    });
    const placement = currentSteeringPlacement(runtimeInput);
    const admission = await admitDurableThreadInput({
      executionHost,
      input: acceptedInput,
      kind: "steer",
      placement,
      threadKey,
    });
    if (admission.kind === "admitted") {
      return;
    }

    queueRuntimeInput(runtimeInput, {
      input: acceptedInput,
      placement,
    });
  });
  runtimeInput.pending = next.catch(() => undefined);
  await next;
}

export async function claimOrphanDurableThreadInput({
  executionHost,
  threadKey,
}: {
  readonly executionHost: ExecutionHost | undefined;
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

  return {
    awaitBoundaries: false,
    durableInputClaim: claimed.record,
    initialEvents: [],
    preUserRuntimeInputs: [],
    run: new BufferedAgentTurn(),
    runtimeInput: createRuntimeInputState([]),
  };
}

export async function prepareQueuedDurableInput({
  executionHost,
  item,
  threadKey,
}: {
  readonly executionHost: ExecutionHost | undefined;
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

  item.run.close();
  return;
}
