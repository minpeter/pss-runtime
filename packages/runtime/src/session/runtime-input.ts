import type { AgentEvent, RuntimeInput } from "./events";
import type { AgentInput, UserInput } from "./input";
import { normalizeAgentInput } from "./input-normalization";
import type { BufferedAgentRun } from "./run";

export type RuntimeInputPlacement = RuntimeInput["placement"];

export interface QueuedRuntimeInput {
  readonly input: UserInput;
  readonly placement: RuntimeInputPlacement;
}

export interface RuntimeInputState {
  closedReason?: string;
  pending: Promise<void>;
  placement?: RuntimeInputPlacement;
  readonly queue: QueuedRuntimeInput[];
  steerPlacement?: RuntimeInputPlacement;
}

export interface QueuedInput {
  readonly initialEvents: AgentEvent[];
  readonly input?: UserInput;
  readonly preUserRuntimeInputs: QueuedRuntimeInput[];
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
}

export function createRuntimeInputState(
  queue: QueuedRuntimeInput[]
): RuntimeInputState {
  return {
    pending: Promise.resolve(),
    queue,
  };
}

export function addSteeringInput(
  runtimeInput: RuntimeInputState,
  input: AgentInput
): Promise<void> {
  const next = runtimeInput.pending.then(() => {
    if (runtimeInput.closedReason) {
      throw runtimeInputClosedError(runtimeInput.closedReason);
    }

    queueRuntimeInput(runtimeInput, {
      input: normalizeAgentInput(input),
      placement:
        runtimeInput.steerPlacement ?? runtimeInput.placement ?? "step-end",
    });
  });
  runtimeInput.pending = next.catch(() => undefined);
  return next;
}

export function closeRuntimeInput(
  runtimeInput: RuntimeInputState | undefined,
  reason = "the run reached a terminal state"
): void {
  if (runtimeInput && !runtimeInput.closedReason) {
    runtimeInput.closedReason = reason;
    runtimeInput.placement = undefined;
  }
}

export async function withRuntimeInputWindow<T>(
  runtimeInput: RuntimeInputState,
  placement: RuntimeInputPlacement,
  callback: () => Promise<T>
): Promise<T> {
  const previousSteerPlacement = runtimeInput.steerPlacement;
  runtimeInput.placement = placement;
  runtimeInput.steerPlacement = placement;
  try {
    return await callback();
  } finally {
    runtimeInput.placement = undefined;
    runtimeInput.steerPlacement = previousSteerPlacement;
  }
}

export async function withSteeringPlacement<T>(
  runtimeInput: RuntimeInputState,
  placement: RuntimeInputPlacement,
  callback: () => Promise<T>
): Promise<T> {
  const previousSteerPlacement = runtimeInput.steerPlacement;
  runtimeInput.steerPlacement = placement;
  try {
    return await callback();
  } finally {
    runtimeInput.steerPlacement = previousSteerPlacement;
  }
}

export function shiftRuntimeInput(
  runtimeInput: RuntimeInputState,
  placement: RuntimeInputPlacement
): QueuedRuntimeInput | undefined {
  const index = runtimeInput.queue.findIndex(
    (input) => input.placement === placement
  );
  if (index === -1) {
    return;
  }

  return runtimeInput.queue.splice(index, 1)[0];
}

export function queueRuntimeInput(
  runtimeInput: RuntimeInputState,
  input: QueuedRuntimeInput
): void {
  runtimeInput.queue.push(input);
}

function runtimeInputClosedError(reason: string): Error {
  return new Error(`session.steer() cannot be used after ${reason}`);
}
