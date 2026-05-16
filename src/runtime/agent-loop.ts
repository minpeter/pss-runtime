import type { AgentEventListener } from "./events";
import { mockLlm, type Llm } from "./mock-llm";

type RunAgentLoopOptions = {
  emit: AgentEventListener;
  llm?: Llm;
  signal?: AbortSignal;
};

export async function runAgentLoop({
  emit,
  llm = mockLlm,
  signal = new AbortController().signal,
}: RunAgentLoopOptions): Promise<void> {
  while (true) {
    if (signal.aborted) {
      return;
    }

    emit({ type: "turn-start" });
    const output = await llm({ signal });
    let shouldContinue = false;

    if (signal.aborted) {
      emit({ type: "turn-abort" });
      return;
    }

    for (const part of output) {
      if (signal.aborted) {
        emit({ type: "turn-abort" });
        return;
      }

      if (part.type === "text") {
        emit({ type: "text", text: part.text });
        continue;
      }

      emit({ type: "tool-call", toolName: part.toolName });
      shouldContinue = true;
    }

    emit({ type: "turn-end" });

    if (!shouldContinue) {
      return;
    }
  }
}
