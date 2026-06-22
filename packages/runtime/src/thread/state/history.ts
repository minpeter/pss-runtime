import type { ModelMessage } from "ai";
import type { UserInput } from "../input/input";
import { userInputToModelMessage } from "../protocol/mapping";
import {
  type ThreadCompactionRecord,
  validateThreadCompactionRecord,
} from "./snapshot";

export class ModelMessageHistory {
  readonly #compactions: ThreadCompactionRecord[] = [];
  readonly #modelHistory: ModelMessage[] = [];
  readonly #onChange?: (snapshot: ModelMessage[]) => void;

  constructor(
    history?: ModelMessage[],
    onChange?: (snapshot: ModelMessage[]) => void,
    compactions: readonly ThreadCompactionRecord[] = []
  ) {
    if (history) {
      this.#modelHistory = structuredClone(history);
    }
    this.#compactions = compactions.map((record) =>
      validateThreadCompactionRecord(record, this.#modelHistory.length)
    );
    this.#onChange = onChange;
  }

  modelSnapshot(): ModelMessage[] {
    return structuredClone(this.#modelHistory);
  }

  modelContextSnapshot(
    options: { readonly maxMessages?: number } = {}
  ): ModelMessage[] {
    const compacted = applyCompactions(this.#modelHistory, this.#compactions);
    if (
      options.maxMessages === undefined ||
      compacted.length <= options.maxMessages
    ) {
      return compacted;
    }
    return compacted.slice(Math.max(0, compacted.length - options.maxMessages));
  }

  compactionSnapshot(): ThreadCompactionRecord[] {
    return structuredClone(this.#compactions);
  }

  recordCompaction(record: ThreadCompactionRecord): void {
    this.#compactions.push(
      validateThreadCompactionRecord(record, this.#modelHistory.length)
    );
    this.#triggerChange();
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
    for (let index = this.#compactions.length - 1; index >= 0; index -= 1) {
      const record = this.#compactions[index];
      if (!record || record.endSeqExclusive > this.#modelHistory.length) {
        this.#compactions.splice(index, 1);
      }
    }
    this.#triggerChange();
  }

  #triggerChange(): void {
    this.#onChange?.(this.modelSnapshot());
  }
}

function applyCompactions(
  history: readonly ModelMessage[],
  compactions: readonly ThreadCompactionRecord[]
): ModelMessage[] {
  const kept = nonOverlappedCompactions(history.length, compactions);
  if (kept.length === 0) {
    return history.map((message) => structuredClone(message));
  }

  const byStart = new Map<number, ThreadCompactionRecord>();
  for (const record of kept) {
    byStart.set(record.startSeq, record);
  }

  const output: ModelMessage[] = [];
  for (let index = 0; index < history.length; ) {
    const record = byStart.get(index);
    if (record) {
      output.push(structuredClone(record.summary));
      index = record.endSeqExclusive;
      continue;
    }

    const message = history[index];
    if (message) {
      output.push(structuredClone(message));
    }
    index += 1;
  }
  return output;
}

function nonOverlappedCompactions(
  historyLength: number,
  compactions: readonly ThreadCompactionRecord[]
): ThreadCompactionRecord[] {
  const kept: ThreadCompactionRecord[] = [];
  for (let index = compactions.length - 1; index >= 0; index -= 1) {
    const record = compactions[index];
    if (!record || record.endSeqExclusive > historyLength) {
      continue;
    }
    if (kept.some((keptRecord) => overlaps(record, keptRecord))) {
      continue;
    }
    kept.push(record);
  }
  return kept.sort((left, right) => left.startSeq - right.startSeq);
}

function overlaps(
  left: ThreadCompactionRecord,
  right: ThreadCompactionRecord
): boolean {
  return (
    left.startSeq < right.endSeqExclusive &&
    right.startSeq < left.endSeqExclusive
  );
}
