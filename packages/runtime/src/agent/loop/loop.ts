import type { ModelMessage } from "ai";
import {
  generateModelStep,
  type ModelGenerationOptions,
  type ModelStepOutput,
} from "../../llm/llm";
import type { RuntimeToolExecutionContext } from "../../llm/tool-execution";
import type { AgentEvent } from "../../thread/protocol/events";
import { modelMessageToAgentEvents } from "../../thread/protocol/mapping";

interface ModelHistory {
  appendModelMessage(message: ModelMessage): void;
  modelContextSnapshot(): ModelMessage[];
  modelSnapshot(): ModelMessage[];
}

interface RunAgentLoopOptions {
  captureObserverEvents?: ObserverEventCapture;
  emit: AgentLoopEventListener;
  history: ModelHistory;
  model: ModelGenerationOptions;
  signal?: AbortSignal;
  toolExecution?: RuntimeToolExecutionContext;
  transformModelContext?: (
    messages: readonly ModelMessage[],
    signal: AbortSignal
  ) => Promise<readonly ModelMessage[]>;
  transformModelStep?: (
    messages: ModelStepOutput,
    signal: AbortSignal
  ) => Promise<ModelStepOutput>;
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
  model,
  signal = new AbortController().signal,
  toolExecution,
  transformModelContext,
  transformModelStep,
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
      readModelOutput({
        history,
        model,
        signal,
        toolExecution,
        transformModelContext,
      })
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
      transformModelStep,
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

async function readModelOutput({
  history,
  model,
  signal,
  toolExecution,
  transformModelContext,
}: Pick<RunAgentLoopOptions, "history" | "model" | "transformModelContext"> & {
  signal: AbortSignal;
  toolExecution?: RuntimeToolExecutionContext;
}): Promise<ModelStepOutput | "aborted"> {
  try {
    const snapshot = history.modelContextSnapshot();
    return await generateModelStep({
      history: transformModelContext
        ? await transformModelContext(snapshot, signal)
        : snapshot,
      ...model,
      signal,
      toolExecution,
    });
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
  transformModelStep,
}: Pick<RunAgentLoopOptions, "emit" | "transformModelStep"> & {
  history: ModelHistory;
} & {
  capturedOutput: ObserverEventCaptureResult<ModelStepOutput | "aborted">;
  output: ModelStepOutput;
  signal: AbortSignal;
}): Promise<StepOutputResult> {
  try {
    const transformedOutput = transformModelStep
      ? await transformModelStep(output, signal)
      : output;
    return await appendStepOutput({
      emit,
      history,
      observerEvents: capturedOutput.events,
      output: transformedOutput,
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
  output: ModelStepOutput;
  signal: AbortSignal;
}): Promise<StepOutputResult> {
  if (signal.aborted) {
    return "aborted";
  }

  let shouldContinue = false;
  const pendingObserverEvents = observerEvents;
  const flushObserverEvents = async () => {
    for (let index = 0; index < pendingObserverEvents.length; ) {
      const event = pendingObserverEvents[index];
      if (event) {
        pendingObserverEvents.splice(index, 1);
        await emit(event);
      } else {
        index += 1;
      }
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
        await flushObserverEvents();
      }
    }

    if (hasToolResult) {
      await flushObserverEvents();
    }
  }

  await flushObserverEvents();

  return shouldContinue ? "continue" : "completed";
}
