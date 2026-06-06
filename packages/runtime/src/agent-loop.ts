import type { ModelMessage } from "ai";
import type { RuntimeLlm, RuntimeLlmOutput } from "./llm";
import type { AgentEvent } from "./session/events";
import { modelMessageToAgentEvents } from "./session/mapping";

interface ModelHistory {
  appendModelMessage(message: ModelMessage): void;
  modelSnapshot(): ModelMessage[];
}

interface RunAgentLoopOptions {
  captureObserverEvents?: ObserverEventCapture;
  emit: AgentLoopEventListener;
  history: ModelHistory;
  llm: RuntimeLlm;
  signal?: AbortSignal;
}

type AgentLoopResult = "completed" | "aborted";
type AgentLoopBoundaryEvent = Extract<
  AgentEvent,
  { type: "step-end" } | { type: "step-start" }
>;
interface AgentLoopBoundaryDecision {
  readonly runtimeInputAdded?: boolean;
}
type AgentLoopEventListener = (
  event: AgentEvent
) =>
  | AgentLoopBoundaryDecision
  | Promise<AgentLoopBoundaryDecision | undefined>
  | undefined;
type StepOutputResult = "aborted" | "completed" | "continue";
interface ObserverEventCaptureResult<T> {
  readonly events: AgentEvent[];
  readonly release: () => void;
  readonly value: T;
}
type ObserverEventCapture = <T>(
  callback: () => Promise<T>
) => Promise<ObserverEventCaptureResult<T>>;

export async function runAgentLoop({
  captureObserverEvents = captureNoObserverEvents,
  emit,
  history,
  llm,
  signal = new AbortController().signal,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  while (true) {
    if (signal.aborted) {
      return "aborted";
    }

    const stepStartDecision = await emitBoundary({
      emit,
      event: { type: "step-start" },
      signal,
    });

    if (stepStartDecision === "aborted") {
      return "aborted";
    }

    const capturedOutput = await captureObserverEvents(() =>
      readLlmOutput({ history, llm, signal })
    );
    const output = capturedOutput.value;

    if (output === "aborted") {
      return "aborted";
    }

    const result = await appendCapturedStepOutput({
      capturedOutput,
      emit,
      history,
      output,
      signal,
    });

    if (result === "aborted") {
      return "aborted";
    }

    const stepEndDecision = await emitBoundary({
      emit,
      event: { type: "step-end" },
      signal,
    });

    if (stepEndDecision === "aborted") {
      return "aborted";
    }

    // Runtime input after step-end intentionally forces another inference step,
    // even after final-looking assistant text. Unconditional insertion on every
    // step-end can create an unbounded loop.
    if (result === "completed" && !stepEndDecision?.runtimeInputAdded) {
      return "completed";
    }
  }
}

async function emitBoundary({
  emit,
  event,
  signal,
}: Pick<RunAgentLoopOptions, "emit"> & {
  event: AgentLoopBoundaryEvent;
  signal: AbortSignal;
}): Promise<AgentLoopBoundaryDecision | "aborted" | undefined> {
  if (signal.aborted) {
    return "aborted";
  }

  const abort = createAbortBoundary(signal);
  try {
    return await Promise.race([Promise.resolve(emit(event)), abort.promise]);
  } catch (error) {
    if (signal.aborted) {
      return "aborted";
    }

    throw error;
  } finally {
    abort.dispose();
  }
}

function createAbortBoundary(signal: AbortSignal): {
  dispose: () => void;
  promise: Promise<"aborted">;
} {
  let dispose: () => void = () => undefined;

  const promise = new Promise<"aborted">((resolve) => {
    const onAbort = () => resolve("aborted");
    dispose = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  return { dispose, promise };
}

async function captureNoObserverEvents<T>(callback: () => Promise<T>): Promise<{
  readonly events: AgentEvent[];
  readonly release: () => void;
  readonly value: T;
}> {
  return {
    events: [],
    release: releaseNoObserverEvents,
    value: await callback(),
  };
}

function releaseNoObserverEvents(): void {
  return;
}

async function readLlmOutput({
  history,
  llm,
  signal,
}: Pick<RunAgentLoopOptions, "history" | "llm"> & {
  signal: AbortSignal;
}): Promise<RuntimeLlmOutput | "aborted"> {
  try {
    return await llm({ history: history.modelSnapshot(), signal });
  } catch (error) {
    if (signal.aborted) {
      return "aborted";
    }

    throw error;
  }
}

async function appendCapturedStepOutput({
  capturedOutput,
  emit,
  history,
  output,
  signal,
}: Pick<RunAgentLoopOptions, "emit"> & { history: ModelHistory } & {
  capturedOutput: ObserverEventCaptureResult<RuntimeLlmOutput | "aborted">;
  output: RuntimeLlmOutput;
  signal: AbortSignal;
}): Promise<StepOutputResult> {
  try {
    return await appendStepOutput({
      emit,
      history,
      observerEvents: capturedOutput.events,
      output,
      signal,
    });
  } finally {
    capturedOutput.release();
  }
}

async function appendStepOutput({
  emit,
  history,
  observerEvents,
  output,
  signal,
}: Pick<RunAgentLoopOptions, "emit"> & { history: ModelHistory } & {
  observerEvents: AgentEvent[];
  output: RuntimeLlmOutput;
  signal: AbortSignal;
}): Promise<StepOutputResult> {
  if (signal.aborted) {
    return "aborted";
  }

  let shouldContinue = false;
  const pendingObserverEvents = observerEvents;
  const flushObserverEvents = async (
    shouldFlush: (event: AgentEvent) => boolean = () => true
  ) => {
    for (let index = 0; index < pendingObserverEvents.length; ) {
      const event = pendingObserverEvents[index];
      if (!(event && shouldFlush(event))) {
        index += 1;
        continue;
      }
      pendingObserverEvents.splice(index, 1);
      await emit(event);
    }
  };

  for (const message of output) {
    if (signal.aborted) {
      return "aborted";
    }

    history.appendModelMessage(message);
    const events = modelMessageToAgentEvents(message);
    const hasToolResult = events.some((event) => event.type === "tool-result");

    for (const event of events) {
      await emit(event);
      if (event.type === "tool-call") {
        shouldContinue = true;
        await flushObserverEvents(isLaunchOrBlockingObserverEvent);
      }
    }

    if (hasToolResult) {
      await flushObserverEvents();
    }
  }

  await flushObserverEvents();

  return shouldContinue ? "continue" : "completed";
}

function isLaunchOrBlockingObserverEvent(event: AgentEvent): boolean {
  if (event.type === "subagent-job-update") {
    return false;
  }

  return !(event.type === "subagent-job-end" && event.task_id);
}
