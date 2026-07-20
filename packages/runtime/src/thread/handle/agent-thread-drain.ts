import type { AgentThreadContext } from "./agent-thread-context";
import { runThreadInputDrainLoop } from "./thread-drain";

export async function drainAgentThreadInputQueue(
  context: AgentThreadContext
): Promise<void> {
  if (context.running) {
    context.drainRequested = true;
    return await (context.drainPromise ?? Promise.resolve());
  }

  context.running = true;
  context.drainRequested = false;
  const drain = runThreadInputDrainLoop({
    activate: ({ abort, run, runtimeInput }) => {
      context.activeAbort = abort;
      context.activeRun = run;
      context.activeRuntimeInput = runtimeInput;
      context.runToCloseOnKill = run;
    },
    continueDraining: () => !(context.killed || context.drainRequested),
    deactivateRun: () => {
      context.activeRun = undefined;
      context.activeRuntimeInput = undefined;
    },
    events: context.events,
    execution: context.execution,
    inputQueue: context.inputQueue,
    model: context.model,
    release: () => {
      context.activeAbort = undefined;
      context.activeRun = undefined;
      context.activeRuntimeInput = undefined;
      context.runToCloseOnKill = undefined;
    },
    state: context.state,
    threadKey: context.threadKey,
  });
  context.drainPromise = drain;
  try {
    await drain;
  } finally {
    const shouldRestart = context.drainRequested && !context.killed;
    context.running = false;
    context.drainPromise = undefined;
    if (shouldRestart) {
      context.drainRequested = false;
      await drainAgentThreadInputQueue(context);
    }
  }
}
