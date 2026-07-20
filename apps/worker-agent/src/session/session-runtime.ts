import type {
  AgentInput,
  StoredThreadEvent,
  ThreadEventReadOptions,
  UserInput,
} from "@minpeter/pss-runtime";
import {
  type AgentHost,
  dispatchAgentNotification,
} from "@minpeter/pss-runtime/execution";

import type {
  ReplayEventsResponse,
  SubmitTurnResponse,
} from "./session-contract";

interface DurableThreadEventReader {
  events(options?: ThreadEventReadOptions): AsyncIterable<StoredThreadEvent>;
}

export async function submitDurableSessionTurn({
  host,
  idempotencyKey,
  input,
  namespace,
  threadKey,
}: {
  readonly host: AgentHost;
  readonly idempotencyKey: string;
  readonly input: AgentInput;
  readonly namespace: string;
  readonly threadKey: string;
}): Promise<SubmitTurnResponse> {
  const admitted = await dispatchAgentNotification({
    host,
    idempotencyKey,
    input: normalizeSessionUserInput(input),
    namespace,
    threadKey,
  });

  return {
    accepted: true,
    runId: admitted.runId,
    threadKey,
  };
}

export async function replayDurableThreadEvents(
  thread: DurableThreadEventReader,
  options: ThreadEventReadOptions = {}
): Promise<ReplayEventsResponse> {
  const events: StoredThreadEvent[] = [];
  for await (const event of thread.events(options)) {
    events.push(event);
  }
  const nextCursor = events.at(-1)?.cursor;
  return {
    events,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function normalizeSessionUserInput(input: AgentInput): UserInput {
  if (typeof input === "string") {
    return { text: input, type: "user-input" };
  }
  if (input.every((part) => typeof part === "string")) {
    return { text: input, type: "user-input" };
  }
  return { content: input, type: "user-input" };
}
