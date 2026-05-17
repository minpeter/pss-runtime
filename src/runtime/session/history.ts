import type { ModelMessage, UserModelMessage } from "ai";
import { modelHistoryItemsFromModelMessage } from "./mapping";
import type { ModelHistoryItem, UserText } from "./events";

export class AgentModelHistory {
  readonly #modelHistory: ModelMessage[] = [];

  get modelMessages(): ModelMessage[] {
    return this.#modelHistory;
  }

  appendUserInput(input: UserText): void {
    this.#modelHistory.push(toUserModelMessage(input));
  }

  publicSnapshot(): ModelHistoryItem[] {
    return this.#modelHistory.flatMap(modelHistoryItemsFromModelMessage);
  }
}

function toUserModelMessage(input: UserText): UserModelMessage {
  return { role: "user", content: input.text };
}
