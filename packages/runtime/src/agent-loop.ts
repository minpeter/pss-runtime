import type { ModelMessage } from "ai";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEvent, AgentEventListener } from "./session/events";
import { modelMessageToAgentEvents } from "./session/mapping";

type MaybePromise<T> = Promise<T> | T;

interface ModelHistory {
  appendModelMessage(message: ModelMessage): void;
  modelSnapshot(): ModelMessage[];
}

interface RunAgentLoopOptions {
  emit: AgentLoopEventListener;
  history: ModelHistory;
  llm: Llm;
  signal?: AbortSignal;
  stepLifecycle?: AgentStepLifecycle;
}

export type AgentLoopResult = "completed" | "aborted";
export type AgentStepResult = "completed" | "continue";
export interface AgentBeforeStepContext {
  readonly history: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly stepIndex: number;
}
export interface AgentAfterStepContext extends AgentBeforeStepContext {
  readonly result: AgentStepResult;
}
export interface AgentStepLifecycle {
  afterStep?(context: AgentAfterStepContext): MaybePromise<void>;
  beforeInference?(context: AgentBeforeStepContext): MaybePromise<void>;
  beforeStep?(context: AgentBeforeStepContext): MaybePromise<void>;
}
type AgentLoopBoundaryEvent = Extract<
  AgentEvent,
  { type: "step-end" } | { type: "step-start" }
>;
interface AgentLoopBoundaryDecision {
  readonly overlayInputAdded?: boolean;
  readonly runtimeInputAdded?: boolean;
}
type AgentLoopEventListener = (
  event: AgentEvent
) =>
  | AgentLoopBoundaryDecision
  | Promise<AgentLoopBoundaryDecision | undefined>
  | undefined;
type StepOutputResult = AgentStepResult | "aborted";

export async function runAgentLoop({
  emit,
  history,
  llm,
  signal = new AbortController().signal,
  stepLifecycle,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  let stepIndex = 0;

  while (true) {
    if (signal.aborted) {
      return "aborted";
    }

    await stepLifecycle?.beforeStep?.({
      history: history.modelSnapshot(),
      signal,
      stepIndex,
    });

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

    await stepLifecycle?.beforeInference?.({
      history: history.modelSnapshot(),
      signal,
      stepIndex,
    });

    if (signal.aborted) {
      return "aborted";
    }

    const output = await readLlmOutput({ history, llm, signal });

    if (output === "aborted") {
      return "aborted";
    }

    const result = appendStepOutput({ emit, history, output, signal });

    if (result === "aborted") {
      return "aborted";
    }

    await runAfterStepLifecycle(stepLifecycle, {
      history: history.modelSnapshot(),
      result,
      signal,
      stepIndex,
    });

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
    if (
      result === "completed" &&
      !stepEndDecision?.runtimeInputAdded &&
      !stepEndDecision?.overlayInputAdded
    ) {
      return "completed";
    }

    stepIndex += 1;
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

async function runAfterStepLifecycle(
  stepLifecycle: AgentStepLifecycle | undefined,
  context: AgentAfterStepContext
): Promise<void> {
  const afterStep = stepLifecycle?.afterStep;
  if (!afterStep) {
    return;
  }

  await Promise.allSettled([Promise.resolve().then(() => afterStep(context))]);
}

async function readLlmOutput({
  history,
  llm,
  signal,
}: Pick<RunAgentLoopOptions, "history" | "llm"> & {
  signal: AbortSignal;
}): Promise<LlmOutput | "aborted"> {
  try {
    return await llm({ history: history.modelSnapshot(), signal });
  } catch (error) {
    if (signal.aborted) {
      return "aborted";
    }

    throw error;
  }
}

function appendStepOutput({
  emit,
  history,
  output,
  signal,
}: { emit: AgentEventListener; history: ModelHistory } & {
  output: LlmOutput;
  signal: AbortSignal;
}): StepOutputResult {
  if (signal.aborted) {
    return "aborted";
  }

  let shouldContinue = false;

  for (const message of output) {
    if (signal.aborted) {
      return "aborted";
    }

    history.appendModelMessage(message);
    const events = modelMessageToAgentEvents(message);

    for (const event of events) {
      emit(event);
    }

    if (events.some((event) => event.type === "tool-call")) {
      shouldContinue = true;
    }
  }

  return shouldContinue ? "continue" : "completed";
}
