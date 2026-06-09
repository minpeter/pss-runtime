import type { AgentEvent, RuntimeInput } from "./events";
import type { UserInput } from "./input";
import { stripInputMeta } from "./input-meta";
import type { BufferedAgentRun } from "./run";
import type { QueuedRuntimeInput } from "./runtime-input";
import type { SessionEventDispatcher } from "./session-events";
import type { SessionState } from "./session-state";

export function runtimeInputEventFromQueued(
  queued: QueuedRuntimeInput
): RuntimeInput {
  return {
    input: queued.input,
    meta: queued.input.meta,
    placement: queued.placement,
    type: "runtime-input",
  };
}

export async function commitPreUserRuntimeInputs(
  events: SessionEventDispatcher,
  state: SessionState,
  runtimeInputs: readonly QueuedRuntimeInput[]
): Promise<readonly AgentEvent[]> {
  const committed: AgentEvent[] = [];
  for (const queued of runtimeInputs) {
    const processed = await events.interceptEvent(
      runtimeInputEventFromQueued(queued)
    );
    if (processed === "handled") {
      continue;
    }

    committed.push(processed);
    const input = runtimeInputHistoryFromEvent(processed, queued);
    state.appendUserInput(input);
    await state.commit();
  }

  return committed;
}

export function emitCommittedRuntimeInputs(
  events: SessionEventDispatcher,
  run: BufferedAgentRun,
  committed: readonly AgentEvent[]
): void {
  for (const event of committed) {
    events.emitProcessedEvent(run, event);
  }
}

export async function emitRuntimeInputEvent(
  events: SessionEventDispatcher,
  run: BufferedAgentRun,
  state: SessionState,
  queued: QueuedRuntimeInput
): Promise<boolean> {
  const processed = await events.interceptEvent(
    runtimeInputEventFromQueued(queued)
  );
  if (processed === "handled") {
    return false;
  }

  events.emitProcessedEvent(run, processed);
  state.appendUserInput(runtimeInputHistoryFromEvent(processed, queued));
  await state.commit();
  return true;
}

function runtimeInputHistoryFromEvent(
  processed: AgentEvent,
  queued: QueuedRuntimeInput
): UserInput {
  if (processed.type === "runtime-input") {
    return stripInputMeta(processed.input);
  }

  return stripInputMeta(queued.input);
}
