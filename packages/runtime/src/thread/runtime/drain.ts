import type { ExecutionHost } from "../../execution/host/types";
import type { RuntimeAttachmentStore } from "../input/attachments";
import {
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "../input/runtime-input";
import { emitRuntimeInputEvent } from "../input/runtime-input-emit";
import type { AgentEvent } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadState } from "../state/thread-state";
import {
  ackDurableThreadInput,
  claimDurableThreadInput,
  commitAndAckDurableThreadInput,
  releaseDurableThreadInputClaim,
} from "./durable-inputs";
import type { ThreadEventDispatcher } from "./events";

export async function drainRuntimeInput({
  events,
  executionHost,
  placement,
  run,
  runtimeInput,
  state,
  threadKey,
  attachmentStore,
  recordEvent,
}: {
  readonly attachmentStore: RuntimeAttachmentStore | undefined;
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: ExecutionHost;
  readonly placement: RuntimeInputPlacement;
  readonly recordEvent?: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<boolean> {
  let added = false;
  let next = shiftRuntimeInput(runtimeInput, placement);
  while (next) {
    if (
      await emitRuntimeInputEvent(events, run, state, next, {
        attachmentStore,
        recordEvent,
      })
    ) {
      added = true;
    }
    next = shiftRuntimeInput(runtimeInput, placement);
  }

  return (
    (await drainDurableRuntimeInput({
      events,
      executionHost,
      attachmentStore,
      placement,
      recordEvent,
      run,
      state,
      threadKey,
    })) || added
  );
}

async function drainDurableRuntimeInput({
  events,
  executionHost,
  attachmentStore,
  placement,
  run,
  state,
  threadKey,
  recordEvent,
}: {
  readonly events: ThreadEventDispatcher;
  readonly executionHost?: ExecutionHost;
  readonly attachmentStore: RuntimeAttachmentStore | undefined;
  readonly placement: RuntimeInputPlacement;
  readonly recordEvent?: (event: AgentEvent) => void;
  readonly run: BufferedAgentTurn;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<boolean> {
  let added = false;
  for (;;) {
    const claimed = await claimDurableThreadInput({
      boundary: placement,
      executionHost,
      threadKey,
    });
    if (claimed.kind === "unavailable" || !claimed.record) {
      return added;
    }

    const record = claimed.record;
    try {
      const inputAdded = await emitRuntimeInputEvent(
        events,
        run,
        state,
        {
          input: record.input,
          placement,
        },
        {
          attachmentStore,
          commit: () =>
            commitAndAckDurableThreadInput({
              executionHost,
              record,
              state,
            }),
          onHandled: () =>
            ackDurableThreadInput({
              executionHost,
              record,
            }),
          recordEvent,
        }
      );
      added = inputAdded || added;
    } catch (error) {
      await releaseDurableThreadInputClaim({
        executionHost,
        record,
      });
      throw error;
    }
  }
}
