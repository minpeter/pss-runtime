import type { ExecutionHost } from "../../execution/host/types";
import {
  type RuntimeInputState,
  withRuntimeInputWindow,
} from "../input/runtime-input";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadState } from "../state/thread-state";
import { drainRuntimeInput } from "./drain";
import type { ThreadEventDispatcher } from "./events";

export async function emitTurnEvent({
  event,
  events,
  executionHost,
  awaitBoundaries,
  run,
  runtimeInput,
  state,
  threadKey,
}: {
  readonly event: AgentEvent;
  readonly awaitBoundaries: boolean;
  readonly events: ThreadEventDispatcher;
  readonly executionHost: ExecutionHost | undefined;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<{ readonly runtimeInputAdded: boolean } | undefined> {
  if (event.type !== "step-start" && event.type !== "step-end") {
    await events.emitRunEvent(run, event);
    return;
  }

  await withRuntimeInputWindow(runtimeInput, event.type, async () => {
    await events.emitRunBoundaryEvent(run, event, {
      awaitAck: awaitBoundaries,
    });
  });
  const runtimeInputAdded = await drainRuntimeInput({
    events,
    executionHost,
    placement: event.type,
    run,
    runtimeInput,
    state,
    threadKey,
  });
  return event.type === "step-end" ? { runtimeInputAdded } : undefined;
}
