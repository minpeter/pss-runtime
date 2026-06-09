import { InMemoryExecutionStore } from "./memory-store";
import type {
  ExecutionHost,
  ExecutionScheduler,
  ResumeSessionOptions,
} from "./types";

export function createInMemoryExecutionHost(): ExecutionHost {
  return {
    capabilities: {},
    store: new InMemoryExecutionStore(),
    scheduler: new InMemoryExecutionScheduler(),
  };
}

class InMemoryExecutionScheduler implements ExecutionScheduler {
  readonly #queuedRunIds: string[] = [];
  readonly #resumedSessions: {
    readonly options: ResumeSessionOptions;
    readonly sessionKey: string;
  }[] = [];

  enqueueRun(runId: string): Promise<void> {
    this.#queuedRunIds.push(runId);
    return Promise.resolve();
  }

  resumeSession(
    sessionKey: string,
    options: ResumeSessionOptions
  ): Promise<void> {
    this.#resumedSessions.push({ options, sessionKey });
    return Promise.resolve();
  }
}
