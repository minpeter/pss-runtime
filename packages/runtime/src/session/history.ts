import type { ModelMessage } from "ai";
import type { UserText } from "./events";
import { userTextToModelMessage } from "./mapping";

export class AgentModelHistory {
  readonly #modelHistory: ModelMessage[] = [];

  constructor(initialHistory?: ModelMessage[]) {
    if (initialHistory) {
      this.#modelHistory = structuredClone(initialHistory);
    }
  }

  modelSnapshot(): ModelMessage[] {
    return structuredClone(this.#modelHistory);
  }

  appendUserInput(input: UserText): void {
    this.#modelHistory.push(userTextToModelMessage(input));
  }

  appendModelMessage(message: ModelMessage): void {
    this.#modelHistory.push(structuredClone(message));
  }
}

