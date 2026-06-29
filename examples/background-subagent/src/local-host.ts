import type { Agent, AgentTurn } from "@minpeter/pss-runtime";
import type {
  ExecutionHost,
  ResumeThreadOptions,
} from "@minpeter/pss-runtime/execution";
import { createInMemoryExecutionHost } from "@minpeter/pss-runtime/platform/memory";

const defaultResumeTimeoutMs = 60_000;

interface LocalThreadPrompt {
  readonly options: ResumeThreadOptions;
  readonly threadKey: string;
}

interface LocalThreadPromptState {
  readonly pendingErrors: Error[];
  readonly pendingPrompts: LocalThreadPrompt[];
  readonly waiters: ThreadPromptWaiter[];
}

interface ThreadPromptWaiter {
  reject(error: Error): void;
  resolve(prompt: LocalThreadPrompt): void;
}

export interface LocalHost extends ExecutionHost {
  resumeThread(options?: { readonly timeoutMs?: number }): Promise<AgentTurn>;
}

class LocalHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalHostError";
  }
}

export function localHost({
  agent,
}: {
  readonly agent: () => Agent;
}): LocalHost {
  const baseHost = createInMemoryExecutionHost();
  const promptState: LocalThreadPromptState = {
    pendingErrors: [],
    pendingPrompts: [],
    waiters: [],
  };
  const host: ExecutionHost = {
    ...baseHost,
    scheduler: {
      enqueueRun: async (runId, options) => {
        await baseHost.scheduler.enqueueRun(runId, options);
        resumeQueuedRun(agent, runId, promptState);
      },
      resumeThread: async (threadKey, options) => {
        await baseHost.scheduler.resumeThread(threadKey, options);
        publishPrompt(promptState, { options, threadKey });
      },
    },
  };

  return {
    ...host,
    resumeThread: async (options) => {
      const prompt = await waitForPrompt(
        promptState,
        options?.timeoutMs ?? defaultResumeTimeoutMs
      );
      if (!prompt.options.runId) {
        throw new LocalHostError(
          `Thread ${prompt.threadKey} resumed without a run id.`
        );
      }

      const run = await agent().resume(prompt.options.runId);
      if (!run) {
        throw new LocalHostError(
          `Run ${prompt.options.runId} was already consumed.`
        );
      }
      return run;
    },
  };
}

function publishPrompt(
  state: LocalThreadPromptState,
  prompt: LocalThreadPrompt
): void {
  const waiter = state.waiters.shift();
  if (waiter) {
    waiter.resolve(prompt);
    return;
  }

  state.pendingPrompts.push(prompt);
}

function publishError(state: LocalThreadPromptState, error: Error): void {
  const waiter = state.waiters.shift();
  if (waiter) {
    waiter.reject(error);
    return;
  }

  state.pendingErrors.push(error);
}

function resumeQueuedRun(
  agent: () => Agent,
  runId: string,
  state: LocalThreadPromptState
): void {
  queueMicrotask(() => {
    agent()
      .resume(runId)
      .then((run) => {
        if (!run) {
          publishError(
            state,
            new LocalHostError(`Run ${runId} was not resumable.`)
          );
        }
      })
      .catch((error: unknown) => {
        publishError(state, errorMessage(error));
      });
  });
}

function waitForPrompt(
  state: LocalThreadPromptState,
  timeoutMs: number
): Promise<LocalThreadPrompt> {
  const pendingError = state.pendingErrors.shift();
  if (pendingError) {
    return Promise.reject(pendingError);
  }

  const pendingPrompt = state.pendingPrompts.shift();
  if (pendingPrompt) {
    return Promise.resolve(pendingPrompt);
  }

  let waiter: ThreadPromptWaiter | undefined;
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    const index = waiter ? state.waiters.indexOf(waiter) : -1;
    if (index >= 0) {
      state.waiters.splice(index, 1);
    }
  };
  const complete = (action: () => void) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    action();
  };

  return new Promise<LocalThreadPrompt>((resolve, reject) => {
    waiter = {
      reject: (error) => complete(() => reject(error)),
      resolve: (prompt) => complete(() => resolve(prompt)),
    };
    timeoutId = setTimeout(
      () =>
        complete(() =>
          reject(
            new LocalHostError(
              `No thread prompt resume arrived within ${timeoutMs}ms.`
            )
          )
        ),
      timeoutMs
    );
    state.waiters.push(waiter);
  });
}

function errorMessage(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new LocalHostError(String(error));
}
