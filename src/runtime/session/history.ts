import type { ModelMessage, UserModelMessage } from "ai";
import type { ModelHistoryItem, UserText } from "./events";
import { agentEventsFromModelMessage } from "./mapping";

export class AgentModelHistory {
  readonly #modelHistory: ModelMessage[] = [];

  get modelMessages(): ModelMessage[] {
    return this.#modelHistory;
  }

  appendUserInput(input: UserText): void {
    this.#modelHistory.push(toUserModelMessage(input));
  }

  publicSnapshot(): ModelHistoryItem[] {
    return this.#modelHistory.flatMap(agentEventsFromModelMessage);
  }
}

function toUserModelMessage(input: UserText): UserModelMessage {
  return { role: "user", content: input.text };
}
