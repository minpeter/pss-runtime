import type { ModelMessage } from "ai";
import type { AgentHooks, AgentStepResult } from "./hooks";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEvent, AgentEventListener } from "./session/events";
import { modelMessageToAgentEvents } from "./session/mapping";

interface ModelHistory {
  appendModelMessage(message: ModelMessage): void;
  modelSnapshot(): ModelMessage[];
}

interface RunAgentLoopOptions {
  emit: AgentLoopEventListener;
  history: ModelHistory;
  hooks?: AgentHooks;
  llm: Llm;
  signal?: AbortSignal;
}

export type AgentLoopResult = "completed" | "aborted";
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
type StepOutputResult = AgentStepResult | "aborted";

export async function runAgentLoop({
  emit,
  history,
  hooks,
  llm,
  signal = new AbortController().signal,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  let stepIndex = 0;

  while (true) {
    if (signal.aborted) {
      return "aborted";
    }

    await hooks?.beforeStep?.({
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

    const output = await readLlmOutput({ history, llm, signal });

    if (output === "aborted") {
      return "aborted";
    }

    const result = appendStepOutput({ emit, history, output, signal });

    if (result === "aborted") {
      return "aborted";
    }

    await runAfterStepHook(hooks, {
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
    if (result === "completed" && !stepEndDecision?.runtimeInputAdded) {
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

async function runAfterStepHook(
  hooks: AgentHooks | undefined,
  context: Parameters<NonNullable<AgentHooks["afterStep"]>>[0]
): Promise<void> {
  const hook = hooks?.afterStep;
  if (!hook) {
    return;
  }

  await Promise.allSettled([Promise.resolve().then(() => hook(context))]);
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
