import type {
  ExecutionHost,
  ExecutionScheduler,
  ResumeThreadOptions,
} from "../host/types";
import { InMemoryExecutionStore } from "./store";

export function createInMemoryExecutionHost(): ExecutionHost {
  return {
    kind: "execution",
    store: new InMemoryExecutionStore(),
    scheduler: new InMemoryExecutionScheduler(),
  };
}

class InMemoryExecutionScheduler implements ExecutionScheduler {
  readonly #queuedRunIds: string[] = [];
  readonly #resumedThreads: {
    readonly options: ResumeThreadOptions;
    readonly threadKey: string;
  }[] = [];

  enqueueRun(runId: string): Promise<void> {
    this.#queuedRunIds.push(runId);
    return Promise.resolve();
  }

  resumeThread(threadKey: string, options: ResumeThreadOptions): Promise<void> {
    this.#resumedThreads.push({ options, threadKey });
    return Promise.resolve();
  }
}
