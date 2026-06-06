import type { AgentHooks } from "../hooks";
import type { RuntimeInput } from "./events";
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
  readonly input: UserInput;
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

    runtimeInput.queue.push({
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

export function hooksForRuntimeInput(
  hooks: AgentHooks | undefined,
  runtimeInput: RuntimeInputState
): AgentHooks | undefined {
  if (!hooks) {
    return;
  }

  return {
    ...hooks,
    afterStep: (context) =>
      withSteeringPlacement(runtimeInput, "step-end", async () => {
        await hooks.afterStep?.(context);
      }),
    beforeStep: (context) =>
      withSteeringPlacement(runtimeInput, "step-start", async () => {
        await hooks.beforeStep?.(context);
      }),
  };
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

function runtimeInputClosedError(reason: string): Error {
  return new Error(`session.steer() cannot be used after ${reason}`);
}
