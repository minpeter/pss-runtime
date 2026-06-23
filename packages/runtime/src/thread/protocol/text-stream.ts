import type { AgentEvent } from "./events";
import type { AgentTurn } from "./turn";

function isAssistantOutput(
  event: AgentEvent
): event is Extract<AgentEvent, { type: "assistant-output" }> {
  return event.type === "assistant-output";
}

export async function* streamAssistantText(
  turn: AgentTurn
): AsyncGenerator<string> {
  for await (const event of turn.events()) {
    if (isAssistantOutput(event)) {
      yield event.text;
    }
  }
}

export async function collectAssistantText(turn: AgentTurn): Promise<string> {
  let text = "";
  for await (const chunk of streamAssistantText(turn)) {
    text += chunk;
  }
  return text;
}
