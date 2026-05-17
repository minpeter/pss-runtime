import {
  agentEventsFromModelMessage,
  hasAssistantToolCall,
} from "./session/mapping";
import type { AgentEventListener } from "./session/events";
import type { Llm } from "./llm";
import type { ModelMessage } from "ai";

type RunAgentLoopOptions = {
  emit: AgentEventListener;
  history: ModelMessage[];
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

    emit({ type: "step-end" });

    if (!shouldContinue) {
      return "completed";
    }
  }
}
