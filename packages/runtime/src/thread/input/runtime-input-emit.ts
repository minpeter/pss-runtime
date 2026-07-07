import type { AgentEvent, RuntimeInput } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadEventDispatcher } from "../runtime/events";
import type { ThreadState } from "../state/thread-state";
import {
  type RuntimeAttachmentStore,
  stageUserInputAttachments,
} from "./attachments";
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
  events: ThreadEventDispatcher,
  state: ThreadState,
  runtimeInputs: readonly QueuedRuntimeInput[],
  attachmentStore: RuntimeAttachmentStore | undefined
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
    const input = await stageUserInputAttachments(
      runtimeInputHistoryFromEvent(processed, queued),
      attachmentStore,
      { trustRuntimeAttachmentRefs: true }
    );
    if (queued.canonical === false) {
      state.appendTransientUserInput(input);
    } else {
      state.appendUserInput(input);
      await state.commit();
    }
  }

  return committed;
}

export function emitCommittedRuntimeInputs(
  events: ThreadEventDispatcher,
  run: BufferedAgentTurn,
  committed: readonly AgentEvent[],
  recordEvent?: (event: AgentEvent) => void
): void {
  for (const event of committed) {
    events.emitProcessedEvent(run, event);
    recordEvent?.(event);
  }
}

export async function emitRuntimeInputEvent(
  events: ThreadEventDispatcher,
  run: BufferedAgentTurn,
  state: ThreadState,
  queued: QueuedRuntimeInput,
  options: {
    readonly attachmentStore?: RuntimeAttachmentStore;
    readonly commit?: () => Promise<void>;
    readonly onHandled?: () => Promise<void>;
    readonly recordEvent?: (event: AgentEvent) => void;
  } = {}
): Promise<boolean> {
  const processed = await events.interceptEvent(
    runtimeInputEventFromQueued(queued)
  );
  if (processed === "handled") {
    await options.onHandled?.();
    return false;
  }

  events.emitProcessedEvent(run, processed);
  state.appendUserInput(
    await stageUserInputAttachments(
      runtimeInputHistoryFromEvent(processed, queued),
      options.attachmentStore,
      { trustRuntimeAttachmentRefs: true }
    )
  );
  await (options.commit ?? (() => state.commit()))();
  options.recordEvent?.(processed);
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
