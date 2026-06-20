import type { AgentInput } from "../input/input";
import { attachInputMeta } from "../input/input-meta";
import { normalizeAgentInput } from "../input/input-normalization";
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
  input: AgentInput,
  options: NotifyOptions,
  state: QueueThreadNotificationOptions
): Promise<AgentTurn> {
  const queuedRuntimeInput: QueuedRuntimeInput = {
    input: attachInputMeta(normalizeAgentInput(input), { source: "notify" }),
    placement: "turn-start",
  };
  const observerEvents = cloneObserverEvents(options.observerEvents ?? []);
  const queuedTurn = state.inputQueue[0];
  if (queuedTurn) {
    queuedTurn.initialEvents.push(...observerEvents);
    queuedTurn.preUserRuntimeInputs.push(queuedRuntimeInput);
    return queuedTurn.run;
  }

  const activeRun = state.activeRun;
  const runtimeInput = state.activeRuntimeInput;
  if (runtimeInput && activeRun && !runtimeInput.closedReason) {
    for (const event of observerEvents) {
      await state.emitObserverEvent(activeRun, event);
    }
    queueRuntimeInput(runtimeInput, {
      input: structuredClone(queuedRuntimeInput.input),
      placement: "step-end",
    });
    return activeRun;
  }

  if (options.deferWhenUnobserved === true) {
    state.pendingRuntimeInputs.push(queuedRuntimeInput);
    const deferredRun = new BufferedAgentTurn();
    deferredRun.close();
    return deferredRun;
  }

  const run = new BufferedAgentTurn();
  state.inputQueue.push({
    initialEvents: observerEvents,
    preUserRuntimeInputs: [],
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
