import type { ExecutionHost } from "../../execution/host/types";
import type { AgentEvent } from "../protocol/events";
import type { ThreadState } from "../state/thread-state";

export type DurableThreadEventBuffer = AgentEvent[];

export function recordDurableThreadEvent(
  buffer: DurableThreadEventBuffer,
  event: AgentEvent
): void {
  buffer.push(structuredClone(event));
}

export async function commitThreadStateAndEvents({
  buffer,
  executionHost,
  state,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost?: ExecutionHost;
  readonly state: ThreadState;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = buffer.splice(0);
  const eventLog = executionHost?.store.threadEvents;
  if (!eventLog || pendingEvents.length === 0) {
    try {
      await state.commit();
    } catch (error) {
      buffer.unshift(...pendingEvents);
      throw error;
    }
    return;
  }

  try {
    await state.commitWith(
      async (commit) =>
        await executionHost.store.transaction(async (tx) => {
          const result = await tx.threads.commit(commit.key, commit.next, {
            expectedVersion: commit.expectedVersion,
          });
          if (!result.ok) {
            return result;
          }

          const txEventLog = tx.threadEvents ?? eventLog;
          for (const event of pendingEvents) {
            await txEventLog.append(threadKey, event);
          }
          return result;
        })
    );
  } catch (error) {
    buffer.unshift(...pendingEvents);
    throw error;
  }
}

export async function flushDurableThreadEvents({
  buffer,
  executionHost,
  threadKey,
}: {
  readonly buffer: DurableThreadEventBuffer;
  readonly executionHost?: ExecutionHost;
  readonly threadKey: string;
}): Promise<void> {
  const pendingEvents = buffer.splice(0);
  const eventLog = executionHost?.store.threadEvents;
  if (!eventLog || pendingEvents.length === 0) {
    return;
  }

  try {
    await executionHost.store.transaction(async (tx) => {
      const txEventLog = tx.threadEvents ?? eventLog;
      for (const event of pendingEvents) {
        await txEventLog.append(threadKey, event);
      }
    });
  } catch (error) {
    buffer.unshift(...pendingEvents);
    throw error;
  }
}
