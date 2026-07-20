import type { ThreadHandle } from "@minpeter/pss-runtime";
import type { ChannelAddress } from "../channel";
import type { createTurnEventCollector } from "../observability";
import { createSessionEventLiveSignal } from "../session/session-events";
import type { WorkerAgentDeliveredMessage } from "./agent-do-delivery";

export const SESSION_SUBMIT_PATH = "/session/turn";
export const SESSION_REPLAY_PATH = "/session/events/replay";
export const SESSION_STREAM_PATH = "/session/events";
export const SESSION_BINDING_STORAGE_KEY = "session:binding";

export interface SessionBindingRecord {
  readonly channel: ChannelAddress;
  readonly sessionScopeKey?: string;
}

export class AgentDoState {
  channel: ChannelAddress | undefined;
  sessionScopeKey: string | undefined;
  observability: ReturnType<typeof createTurnEventCollector> | undefined;
  tuiMessageCapture: WorkerAgentDeliveredMessage[] = [];
  readonly sessionEventLive = createSessionEventLiveSignal();
}

export class AgentDurableObjectInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDurableObjectInvariantError";
  }
}

export function requireRuntimeThread(
  thread: ThreadHandle | undefined
): ThreadHandle {
  if (!thread) {
    throw new AgentDurableObjectInvariantError(
      "Session runtime thread was not initialized."
    );
  }
  return thread;
}
