import type { AgentInput, UserInput } from "../input/input";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import type { NotifyOptions } from "../runtime/notification";
import { queueThreadNotification } from "../runtime/notification";
import type { ThreadCompactionInput } from "../state/thread-state";
import type { AgentThreadContext } from "./agent-thread-context";
import { drainAgentThreadInputQueue } from "./agent-thread-drain";
import {
  assertAgentThreadOpen,
  ensureAgentThreadStarted,
} from "./agent-thread-lifecycle";
import { recoverThreadDurableInputClaims } from "./durable-queue-claims";
import { admitThreadSendInput } from "./durable-queue-send";
import { addDurableSteeringInput } from "./durable-steering";
import { createOverlayRuntimeInput } from "./thread-overlay";

export async function sendAgentThreadInput(
  context: AgentThreadContext,
  input: AgentInput
): Promise<AgentTurn> {
  assertAgentThreadOpen(context);

  const run = new BufferedAgentTurn();
  const loaded = ensureAgentThreadStarted(context);
  await enqueueInputAdmission(context, async () => {
    await loaded;
    await admitSend(context, input, run);
  });
  return run;
}

async function admitSend(
  context: AgentThreadContext,
  input: AgentInput,
  run: BufferedAgentTurn
): Promise<void> {
  assertAgentThreadOpen(context);

  await recoverDurableInputClaims(context);

  assertAgentThreadOpen(context);

  await admitThreadSendInput({
    awaitBoundaries: !(context.running && !context.activeRun),
    drain: () => drainAgentThreadInputQueue(context),
    events: context.events,
    executionHost: context.execution.executionHost,
    attachmentStore: context.model.attachmentStore,
    input,
    inputQueue: context.inputQueue,
    pendingOverlays: context.pendingOverlays,
    pendingRuntimeInputs: context.pendingRuntimeInputs,
    run,
    threadKey: context.threadKey,
  });
  assertAgentThreadOpen(context);
}

export function overlayAgentThreadInput(
  context: AgentThreadContext,
  input: AgentInput
): void {
  assertAgentThreadOpen(context);

  context.pendingOverlays.push(createOverlayRuntimeInput(input));
}

export async function notifyAgentThread(
  context: AgentThreadContext,
  input: AgentInput | UserInput,
  options: NotifyOptions
): Promise<AgentTurn> {
  assertAgentThreadOpen(context);

  await ensureAgentThreadStarted(context);
  await recoverDurableInputClaims(context);

  assertAgentThreadOpen(context);

  return queueThreadNotification(input, options, {
    activeRun: context.activeRun,
    activeRuntimeInput: context.activeRuntimeInput,
    attachmentStore: context.model.attachmentStore,
    drain: () => drainAgentThreadInputQueue(context),
    emitObserverEvent: (run, event) =>
      context.events.emitObserverEvent(run, event),
    executionHost: context.execution.executionHost,
    inputQueue: context.inputQueue,
    pendingRuntimeInputs: context.pendingRuntimeInputs,
    threadKey: context.threadKey,
    throwIfTerminal: () => assertAgentThreadOpen(context),
  });
}

export async function steerAgentThreadInput(
  context: AgentThreadContext,
  input: AgentInput,
  send: () => Promise<AgentTurn>
): Promise<AgentTurn> {
  assertAgentThreadOpen(context);

  const runtimeInput = context.activeRuntimeInput;
  const run = context.activeRun;
  if (!(runtimeInput && run)) {
    return send();
  }

  await addDurableSteeringInput({
    executionHost: context.execution.executionHost,
    attachmentStore: context.model.attachmentStore,
    input,
    runtimeInput,
    threadKey: context.threadKey,
  });
  return run;
}

export async function compactAgentThread(
  context: AgentThreadContext,
  input: ThreadCompactionInput
): Promise<void> {
  assertAgentThreadOpen(context);

  await ensureAgentThreadStarted(context);
  await recoverDurableInputClaims(context);

  assertAgentThreadOpen(context);

  await context.events.compact(context.state, input);
}

async function enqueueInputAdmission<T>(
  context: AgentThreadContext,
  operation: () => Promise<T>
): Promise<T> {
  const next = context.inputAdmissionQueue.then(operation, operation);
  context.inputAdmissionQueue = next.then(
    () => undefined,
    () => undefined
  );
  return await next;
}

async function recoverDurableInputClaims(
  context: AgentThreadContext
): Promise<void> {
  await recoverThreadDurableInputClaims({
    executionHost: context.execution.executionHost,
    state: context.durableInputRecovery,
    threadKey: context.threadKey,
  });
}
