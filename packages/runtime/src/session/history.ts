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
    this.#triggerChange();
  }

  appendModelMessage(message: ModelMessage): void {
    this.#modelHistory.push(structuredClone(message));
    this.#triggerChange();
  }

  rollback(snapshot: ModelMessage[]): void {
    this.#modelHistory.length = 0;
    this.#modelHistory.push(...structuredClone(snapshot));
    this.#triggerChange();
  }

  #triggerChange(): void {
    if (!this.#onChange) {
      return;
    }
    try {
      this.#onChange();
    } catch (error: unknown) {
      // Catch and log synchronous callback errors to prevent them from breaking the core execution loop.
      console.error("Error in AgentModelHistory onChange callback:", error);
    }
  }
}
