import type { ModelMessage } from "ai";
import type { UserInput } from "./input";
import { userInputToModelMessage } from "./mapping";

export class ModelMessageHistory {
  readonly #modelHistory: ModelMessage[] = [];
  readonly #onChange?: (snapshot: ModelMessage[]) => void;

  constructor(
    history?: ModelMessage[],
    onChange?: (snapshot: ModelMessage[]) => void
  ) {
    if (history) {
      this.#modelHistory = structuredClone(history);
    }
    this.#onChange = onChange;
  }

  modelSnapshot(): ModelMessage[] {
    return structuredClone(this.#modelHistory);
  }

  appendUserInput(input: UserInput): void {
    this.#modelHistory.push(userInputToModelMessage(input));
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
    this.#onChange?.(this.modelSnapshot());
  }
}
