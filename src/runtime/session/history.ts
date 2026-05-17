import type { ModelMessage } from "ai";
import {
  modelHistoryItemsFromModelMessage,
  toUserModelMessage,
} from "./converters";
import type { ModelHistoryItem, UserText } from "./events";

export class AgentConversationHistory {
  readonly #modelHistory: ModelMessage[] = [];

  get modelMessages(): ModelMessage[] {
    return this.#modelHistory;
  }

  appendUserInput(input: UserText): void {
    this.#modelHistory.push(toUserModelMessage(input));
  }

  snapshot(): ModelHistoryItem[] {
    return this.#modelHistory.flatMap(modelHistoryItemsFromModelMessage);
  }
}
