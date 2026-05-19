import type { ModelMessage } from "ai";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEventListener } from "./session/events";
import { modelMessageToAgentEvents } from "./session/mapping";

interface ModelHistory {
  appendModelMessage(message: ModelMessage): void;
  modelSnapshot(): ModelMessage[];
}

interface RunAgentLoopOptions {
  emit: AgentEventListener;
  history: ModelHistory;
  llm: Llm;
  signal?: AbortSignal;
}

export type AgentLoopResult = "completed" | "aborted";
type StepOutputResult = "continue" | "completed" | "aborted";

export async function runAgentLoop({
  emit,
  history,
  llm,
  signal = new AbortController().signal,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  while (true) {
    if (signal.aborted) {
      return "aborted";
    }

    emit({ type: "step-start" });
    const output = await readLlmOutput({ history, llm, signal });

    if (output === "aborted") {
      return "aborted";
    }

    const result = appendStepOutput({ emit, history, output, signal });

    if (result === "aborted") {
      return "aborted";
    }

    emit({ type: "step-end" });

    if (result === "completed") {
      return "completed";
    }
  }
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
}: Pick<RunAgentLoopOptions, "emit" | "history"> & {
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
