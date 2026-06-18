import type { AgentEvent, RuntimeInput } from "../protocol/events";
import type { BufferedAgentRun } from "../protocol/run";
import type { SessionEventDispatcher } from "../runtime/events";
import type { SessionState } from "../state/session-state";
import type { UserInput } from "./input";
import { stripInputMeta } from "./input-meta";
import type { QueuedRuntimeInput } from "./runtime-input";

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
