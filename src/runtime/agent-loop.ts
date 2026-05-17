import type { AgentEventListener } from "./session/events";
import type { ModelHistoryItem } from "./session";
import type { Llm } from "./llm";

type RunAgentLoopOptions = {
  emit: AgentEventListener;
  history: ModelHistoryItem[];
  llm: Llm;
  signal?: AbortSignal;
};

export type AgentLoopResult = "completed" | "aborted";

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
    let output;

    try {
      output = await llm({ history: structuredClone(history), signal });
    } catch (error) {
      if (signal.aborted) {
        return "aborted";
      }

      throw error;
    }

    let shouldContinue = false;

    if (signal.aborted) {
      return "aborted";
    }

    for (const part of output) {
      if (signal.aborted) {
        return "aborted";
      }

      history.push(structuredClone(part));

      if (part.type === "assistant-text") {
        emit(part);
        continue;
      }

      emit(part);
      shouldContinue = true;
    }

    emit({ type: "step-end" });

    if (!shouldContinue) {
      return "completed";
    }
  }
}
