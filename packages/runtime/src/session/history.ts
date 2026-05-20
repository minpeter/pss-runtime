import type { ModelMessage } from "ai";
import type { UserText } from "./events";
import { userTextToModelMessage } from "./mapping";

export class AgentModelHistory {
  readonly #modelHistory: ModelMessage[] = [];
  readonly #onChange?: () => void;

  constructor(initialHistory?: ModelMessage[], onChange?: () => void) {
    if (initialHistory) {
      this.#modelHistory = structuredClone(initialHistory);
    }
    this.#onChange = onChange;
  }

  modelSnapshot(): ModelMessage[] {
    return structuredClone(this.#modelHistory);
  }

  appendUserInput(input: UserText): void {
    this.#modelHistory.push(userTextToModelMessage(input));
    this.#onChange?.();
  }

  appendModelMessage(message: ModelMessage): void {
    this.#modelHistory.push(structuredClone(message));
    this.#onChange?.();
  }
}


