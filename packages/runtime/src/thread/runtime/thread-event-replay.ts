import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import type { ThreadExecutionOptions } from "./execution";

export class ThreadEventReplayUnsupportedError extends Error {
  readonly name = "ThreadEventReplayUnsupportedError";

  constructor(threadKey: string) {
    super(
      `thread.events() requires an execution host with thread event replay support for ${JSON.stringify(threadKey)}.`
    );
  }
}

export function readThreadEvents(
  execution: ThreadExecutionOptions,
  threadKey: string,
  options?: ThreadEventReadOptions
): AsyncIterable<StoredThreadEvent> {
  const eventLog = execution.executionHost?.store.threadEvents;
  if (!eventLog) {
    throw new ThreadEventReplayUnsupportedError(threadKey);
  }

  return eventLog.read(threadKey, options);
}
