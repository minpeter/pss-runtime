import type { ModelMessage } from "ai";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEventListener } from "./session/events";
import {
  agentEventsFromModelMessage,
  hasAssistantToolCall,
} from "./session/mapping";

interface RunAgentLoopOptions {
  emit: AgentEventListener;
  history: ModelMessage[];
  llm: Llm;
  signal?: AbortSignal;
}

export type AgentLoopResult = "completed" | "aborted";
type AgentStepResult = AgentLoopResult | "continue";

export async function runAgentLoop({
  emit,
  history,
  llm,
  signal = new AbortController().signal,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  while (!signal.aborted) {
    const result = await runAgentStep({ emit, history, llm, signal });

    if (result !== "continue") {
      return result;
    }
  }

  return "aborted";
}

async function runAgentStep({
  emit,
  history,
  llm,
  signal,
}: Required<RunAgentLoopOptions>): Promise<AgentStepResult> {
  emit({ type: "step-start" });
  const output = await requestLlmOutput({ history, llm, signal });

  if (!output || signal.aborted) {
    return "aborted";
  }

  const result = appendLlmOutput({ emit, history, output, signal });

  if (result === "aborted") {
    return "aborted";
  }

  emit({ type: "step-end" });
  return result;
}

async function requestLlmOutput({
  history,
  llm,
  signal,
}: Pick<Required<RunAgentLoopOptions>, "history" | "llm" | "signal">): Promise<
  LlmOutput | undefined
> {
  try {
    return await llm({ history: structuredClone(history), signal });
  } catch (error) {
    if (signal.aborted) {
      return;
    }

    throw error;
  }
}

interface AppendLlmOutputOptions {
  emit: AgentEventListener;
  history: ModelMessage[];
  output: LlmOutput;
  signal: AbortSignal;
}

function appendLlmOutput({
  emit,
  history,
  output,
  signal,
}: AppendLlmOutputOptions): AgentStepResult {
  let shouldContinue = false;

  for (const message of output) {
    if (signal.aborted) {
      return "aborted";
    }

    history.push(structuredClone(message));
    for (const event of agentEventsFromModelMessage(message)) {
      emit(event);
    }

    if (message.role === "assistant" && hasAssistantToolCall(message)) {
      shouldContinue = true;
    }
  }

  return shouldContinue ? "continue" : "completed";
}
