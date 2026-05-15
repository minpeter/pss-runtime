import type { AgentEventListener } from "./events";
import { mockLlm } from "./mock-llm";

export async function runAgentLoop(emit: AgentEventListener): Promise<string> {
  emit({ type: "agent_start" });

  while (true) {
    emit({ type: "turn_start" });
    const output = await mockLlm();

    if (output.type === "text") {
      emit({ type: "message", text: output.text });
      emit({ type: "turn_end" });
      emit({ type: "agent_end" });
      return output.text;
    }

    emit({ type: "tool_call", toolName: output.toolName });
    emit({ type: "turn_end" });
  }
}
