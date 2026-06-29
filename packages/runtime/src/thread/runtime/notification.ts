import type { AgentInput, UserInput } from "../input/input";
import { attachInputMeta } from "../input/input-meta";
import { normalizeInternalAgentInput } from "../input/input-normalization";
import {
  createRuntimeInputState,
  type QueuedInput,
  type QueuedRuntimeInput,
  queueRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import { errorMessage } from "../state/thread-errors";

export interface NotifyOptions {
  readonly deferWhenUnobserved?: boolean;
  readonly observerEvents?: readonly AgentEvent[];
  readonly overlays?: readonly (AgentInput | UserInput)[];
}

interface QueueThreadNotificationOptions {
  readonly activeRun: BufferedAgentTurn | undefined;
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly drain: () => Promise<void>;
  emitObserverEvent(
    run: BufferedAgentTurn | undefined,
    event: AgentEvent
  ): Promise<void>;
  readonly inputQueue: QueuedInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
}

export async function queueThreadNotification(
  input: AgentInput | UserInput,
  options: NotifyOptions,
  state: QueueThreadNotificationOptions
): Promise<AgentTurn> {
  const queuedRuntimeInput: QueuedRuntimeInput = {
    input: attachInputMeta(normalizeInternalAgentInput(input), {
      source: "notify",
    }),
    placement: "turn-start",
  };
  const queuedOverlays = createNotificationOverlays(options.overlays ?? []);
  const observerEvents = cloneObserverEvents(options.observerEvents ?? []);
  const queuedTurn = state.inputQueue[0];
  if (queuedTurn) {
    queuedTurn.initialEvents.push(...observerEvents);
    queuedTurn.preUserRuntimeInputs.push(...queuedOverlays, queuedRuntimeInput);
    return queuedTurn.run;
  }

  const activeRun = state.activeRun;
  const runtimeInput = state.activeRuntimeInput;
  if (runtimeInput && activeRun && !runtimeInput.closedReason) {
    for (const event of observerEvents) {
      await state.emitObserverEvent(activeRun, event);
    }
    for (const overlay of queuedOverlays) {
      queueRuntimeInput(runtimeInput, { ...overlay, placement: "step-end" });
    }
    queueRuntimeInput(runtimeInput, {
      input: structuredClone(queuedRuntimeInput.input),
      placement: "step-end",
    });
    return activeRun;
  }

  if (options.deferWhenUnobserved === true) {
    state.pendingRuntimeInputs.push(...queuedOverlays);
    state.pendingRuntimeInputs.push(queuedRuntimeInput);
    const deferredRun = new BufferedAgentTurn();
    deferredRun.close();
    return deferredRun;
  }

  const run = new BufferedAgentTurn();
  state.inputQueue.push({
    initialEvents: observerEvents,
    preUserRuntimeInputs: queuedOverlays,
    run,
    runtimeInput: createRuntimeInputState([queuedRuntimeInput]),
  });
  startThreadQueueDrain(run, state.drain);
  return run;
}

export function startThreadQueueDrain(
  run: BufferedAgentTurn,
  drain: () => Promise<void>
): void {
  drain().catch((error: unknown) => {
    run.emit({ type: "turn-error", message: errorMessage(error) });
    run.close();
  });
}

function cloneObserverEvents(events: readonly AgentEvent[]): AgentEvent[] {
  return events.map((event) => structuredClone(event));
}

function createNotificationOverlays(
  overlays: readonly (AgentInput | UserInput)[]
): QueuedRuntimeInput[] {
  return overlays.map((input) => ({
    canonical: false,
    input: attachInputMeta(normalizeInternalAgentInput(input), {
      source: "overlay",
    }),
    placement: "turn-start",
  }));
}
