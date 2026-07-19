import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import { closeKilledRuntimeInputs } from "../runtime/kill";
import { threadKilledError, threadTerminalError } from "../state/thread-errors";
import type { AgentThreadContext } from "./agent-thread-context";
import { readThreadEvents } from "./thread-event-replay";

export function assertAgentThreadOpen(context: AgentThreadContext): void {
  if (context.killed || context.deletePromise) {
    throw threadTerminalError(context.killed);
  }
}

export function readAgentThreadEvents(
  context: AgentThreadContext,
  options?: ThreadEventReadOptions
): AsyncIterable<StoredThreadEvent> {
  return readThreadEvents(context.execution, context.threadKey, options);
}

export function interruptAgentThread(context: AgentThreadContext): void {
  context.activeAbort?.abort();
}

export function deleteAgentThread(
  context: AgentThreadContext,
  kill: () => Promise<void>
): Promise<void> {
  if (!context.deletePromise) {
    context.deletePromise = kill()
      .then(() => deleteThread(context))
      .catch((error: unknown) => {
        context.deletePromise = undefined;
        throw error;
      });
  }
  return context.deletePromise;
}

export async function disposeAgentThread(
  context: AgentThreadContext,
  killThread: () => Promise<void>
): Promise<void> {
  const kill = killThread();
  try {
    await context.drainPromise;
  } finally {
    await kill;
    await shutdownAgentThread(context);
  }
}

export function killAgentThread(context: AgentThreadContext): Promise<void> {
  if (context.killed) {
    return context.killPromise ?? Promise.resolve();
  }

  context.killed = true;
  const killedError = threadKilledError();
  context.pendingOverlays.length = 0;
  context.pendingRuntimeInputs.length = 0;
  context.activeAbort?.abort();
  const immediateClose = closeKilledRuntimeInputs({
    activeRuntimeInput: context.activeRuntimeInput,
    executionHost: context.execution.executionHost,
    inputQueue: context.inputQueue,
    message: killedError.message,
    runToClose: context.runToCloseOnKill ?? context.activeRun,
    threadKey: context.threadKey,
  });
  const admissionClose = context.inputAdmissionQueue.then(() =>
    closeKilledRuntimeInputs({
      activeRuntimeInput: undefined,
      executionHost: context.execution.executionHost,
      inputQueue: context.inputQueue,
      message: killedError.message,
      runToClose: undefined,
      threadKey: context.threadKey,
    })
  );
  context.killPromise = Promise.all([immediateClose, admissionClose]).then(
    () => undefined
  );
  context.killPromise.catch(() => undefined);
  return context.killPromise;
}

async function deleteThread(context: AgentThreadContext): Promise<void> {
  await shutdownAgentThread(context);
  await context.state.delete();
}

export function ensureAgentThreadStarted(
  context: AgentThreadContext
): Promise<void> {
  context.startPromise ??= context.state.ensureLoaded().then(async () => {
    await context.events.startThread();
    context.started = true;
  });
  return context.startPromise;
}

async function shutdownAgentThread(context: AgentThreadContext): Promise<void> {
  if (context.shutdownPromise) {
    return await context.shutdownPromise;
  }
  if (!context.startPromise) {
    return;
  }
  context.shutdownPromise = context.startPromise.then(async () => {
    if (!context.started) {
      return;
    }
    await context.events.shutdownThread();
    context.started = false;
  });
  return await context.shutdownPromise;
}
