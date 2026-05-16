import type { AgentEventListener } from "./events";
import { mockLlm, type Llm } from "./mock-llm";

type RunAgentLoopOptions = {
  emit: AgentEventListener;
  llm?: Llm;
};

export async function runAgentLoop({
  emit,
  llm = mockLlm,
}: RunAgentLoopOptions): Promise<void> {
  emit({ type: "agent-start" });

  while (true) {
    emit({ type: "turn-start" });
    const output = await llm();
    let shouldContinue = false;

    for (const part of output) {
      if (part.type === "text") {
        emit({ type: "text", text: part.text });
        continue;
      }

      emit({ type: "tool-call", toolName: part.toolName });
      shouldContinue = true;
    }

    emit({ type: "turn-end" });

    if (!shouldContinue) {
      emit({ type: "agent-end" });
      return;
    }
  }
}
