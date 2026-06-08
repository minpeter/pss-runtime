import type { AgentEvent } from "./events";
import type { AgentInput } from "./input";
import { normalizeAgentInput } from "./input-normalization";
import { type AgentRun, BufferedAgentRun } from "./run";
import {
  createRuntimeInputState,
  type QueuedInput,
  type QueuedRuntimeInput,
  queueRuntimeInput,
  type RuntimeInputState,
} from "./runtime-input";
import { errorMessage } from "./session-errors";

export interface NotifyOptions {
  readonly deferWhenUnobserved?: boolean;
  readonly observerEvents?: readonly AgentEvent[];
}

interface QueueSessionNotificationOptions {
  readonly activeRun: BufferedAgentRun | undefined;
  readonly activeRuntimeInput: RuntimeInputState | undefined;
  readonly drain: () => Promise<void>;
  readonly inputQueue: QueuedInput[];
  readonly pendingRuntimeInputs: QueuedRuntimeInput[];
}

export function queueSessionNotification(
  input: AgentInput,
  options: NotifyOptions,
  state: QueueSessionNotificationOptions
): AgentRun {
  const queuedRuntimeInput: QueuedRuntimeInput = {
    input: normalizeAgentInput(input),
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
    queueRuntimeInput(runtimeInput, {
      input: structuredClone(queuedRuntimeInput.input),
      placement: "step-end",
    });
    return activeRun;
  }

  if (options.deferWhenUnobserved === true) {
    state.pendingRuntimeInputs.push(queuedRuntimeInput);
    const deferredRun = new BufferedAgentRun();
    deferredRun.close();
    return deferredRun;
  }

  const run = new BufferedAgentRun();
  state.inputQueue.push({
    initialEvents: observerEvents,
    preUserRuntimeInputs: [],
    run,
    runtimeInput: createRuntimeInputState([queuedRuntimeInput]),
  });
  startSessionQueueDrain(run, state.drain);
  return run;
}

export function startSessionQueueDrain(
  run: BufferedAgentRun,
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
