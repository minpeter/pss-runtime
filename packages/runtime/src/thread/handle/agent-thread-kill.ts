import { closeKilledRuntimeInputs } from "../runtime/kill";
import { threadKilledError } from "../state/thread-errors";
import type { AgentThreadContext } from "./agent-thread-context";

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
