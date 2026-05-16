import type { AgentEventListener } from "./session/events";
import type { ModelHistoryItem } from "./session/history";
import { mockLlm, type Llm } from "./mock-llm";

type RunAgentLoopOptions = {
  emit: AgentEventListener;
  llm?: Llm;
  modelHistory?: () => ModelHistoryItem[];
  signal?: AbortSignal;
};

export type AgentLoopResult = "completed" | "aborted";

export async function runAgentLoop({
  emit,
  llm = mockLlm,
  modelHistory = () => [],
  signal = new AbortController().signal,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  while (true) {
    if (signal.aborted) {
      return "aborted";
    }

    emit({ type: "step-start" });
    const output = await llm({ history: modelHistory(), signal });
    let shouldContinue = false;

    if (signal.aborted) {
      return "aborted";
    }

    for (const part of output) {
      if (signal.aborted) {
        return "aborted";
      }

      if (part.type === "text") {
        emit({ type: "text", text: part.text });
        continue;
      }

      emit({ type: "tool-call", toolName: part.toolName });
      shouldContinue = true;
    }

    emit({ type: "step-end" });

    if (!shouldContinue) {
      return "completed";
    }
  }
}
