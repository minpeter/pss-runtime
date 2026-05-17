import type { ModelMessage } from "ai";
import { isModelHistoryItem, toUserModelMessage } from "./converters";
import type { AgentEvent, ModelHistoryItem, UserText } from "./events";

export class AgentConversationHistory {
  readonly #publicHistory: ModelHistoryItem[] = [];
  readonly #modelHistory: ModelMessage[] = [];

  get modelMessages(): ModelMessage[] {
    return this.#modelHistory;
  }

  appendUserInput(input: UserText): void {
    this.#publicHistory.push(structuredClone(input));
    this.#modelHistory.push(toUserModelMessage(input));
  }

  appendPublicEvent(event: AgentEvent): void {
    if (isModelHistoryItem(event)) {
      this.#publicHistory.push(structuredClone(event));
    }
  }

  snapshot(): ModelHistoryItem[] {
    return structuredClone(this.#publicHistory);
  }
}
