import type { Agent, AgentRun } from "@minpeter/pss-runtime";
import {
  createInMemoryExecutionHost,
  type ExecutionHost,
  type ResumeSessionOptions,
} from "@minpeter/pss-runtime/execution";

const defaultResumeTimeoutMs = 60_000;

interface LocalSessionPrompt {
  readonly options: ResumeSessionOptions;
  readonly sessionKey: string;
}

interface LocalSessionPromptState {
  readonly pendingErrors: Error[];
  readonly pendingPrompts: LocalSessionPrompt[];
  readonly waiters: SessionPromptWaiter[];
}

interface SessionPromptWaiter {
  reject(error: Error): void;
  resolve(prompt: LocalSessionPrompt): void;
}

export interface LocalHost extends ExecutionHost {
  resumeSession(options?: { readonly timeoutMs?: number }): Promise<AgentRun>;
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
  const promptState: LocalSessionPromptState = {
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
      resumeSession: async (sessionKey, options) => {
        await baseHost.scheduler.resumeSession(sessionKey, options);
        publishPrompt(promptState, { options, sessionKey });
      },
    },
  };

  return {
    ...host,
    resumeSession: async (options) => {
      const prompt = await waitForPrompt(
        promptState,
        options?.timeoutMs ?? defaultResumeTimeoutMs
      );
      if (!prompt.options.runId) {
        throw new LocalHostError(
          `Session ${prompt.sessionKey} resumed without a run id.`
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
  state: LocalSessionPromptState,
  prompt: LocalSessionPrompt
): void {
  const waiter = state.waiters.shift();
  if (waiter) {
    waiter.resolve(prompt);
    return;
  }

  state.pendingPrompts.push(prompt);
}

function publishError(state: LocalSessionPromptState, error: Error): void {
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
  state: LocalSessionPromptState
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
  state: LocalSessionPromptState,
  timeoutMs: number
): Promise<LocalSessionPrompt> {
  const pendingError = state.pendingErrors.shift();
  if (pendingError) {
    return Promise.reject(pendingError);
  }

  const pendingPrompt = state.pendingPrompts.shift();
  if (pendingPrompt) {
    return Promise.resolve(pendingPrompt);
  }

  let waiter: SessionPromptWaiter | undefined;
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

  return new Promise<LocalSessionPrompt>((resolve, reject) => {
    waiter = {
      reject: (error) => complete(() => reject(error)),
      resolve: (prompt) => complete(() => resolve(prompt)),
    };
    timeoutId = setTimeout(
      () =>
        complete(() =>
          reject(
            new LocalHostError(
              `No session prompt resume arrived within ${timeoutMs}ms.`
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
