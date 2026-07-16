import type { ModelMessage } from "ai";
import type { UserInput } from "../input/input";
import type { CanonicalHistoryPolicyPipeline } from "../plugins/canonical-history";
import { userInputToModelMessage } from "../protocol/mapping";
import {
  type ThreadCompactionRecord,
  validateThreadCompactionRecord,
} from "./snapshot";

export class ModelMessageHistory {
  readonly #compactions: ThreadCompactionRecord[] = [];
  readonly #modelHistory: ModelMessage[] = [];
  readonly #onChange?: (snapshot: ModelMessage[]) => void;
  readonly #policy?: CanonicalHistoryPolicyPipeline;
  readonly #transientMessages: TransientModelMessage[] = [];

  constructor(
    history?: ModelMessage[],
    onChange?: (snapshot: ModelMessage[]) => void,
    compactions: readonly ThreadCompactionRecord[] = [],
    policy?: CanonicalHistoryPolicyPipeline
  ) {
    if (history) {
      this.#modelHistory = structuredClone(history);
    }
    this.#compactions = compactions.map((record) =>
      validateThreadCompactionRecord(record, this.#modelHistory.length)
    );
    this.#onChange = onChange;
    this.#policy = policy;
  }

  modelSnapshot(): ModelMessage[] {
    return structuredClone(this.#modelHistory);
  }

  modelContextSnapshot(
    options: { readonly maxMessages?: number } = {}
  ): ModelMessage[] {
    let compacted = applyCompactions(
      this.#modelHistory,
      this.#compactions,
      this.#transientMessages
    );
    if (this.#policy?.active) {
      compacted = this.#policy.projectModelContext(
        this.#canonicalState(),
        compacted
      );
    }
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
    const validated = validateThreadCompactionRecord(
      record,
      this.#modelHistory.length
    );
    this.#policy?.beforeRecordCompaction(this.#canonicalState(), validated);
    this.#compactions.push(validated);
    this.#triggerChange();
  }

  appendUserInput(input: UserInput): void {
    this.#modelHistory.push(userInputToModelMessage(input));
    this.#triggerChange();
  }

  appendTransientUserInput(input: UserInput): void {
    this.#transientMessages.push({
      index: this.#modelHistory.length,
      message: userInputToModelMessage(input),
    });
  }

  appendModelMessage(message: ModelMessage): void {
    const candidate = structuredClone(message);
    this.#policy?.beforeAppendModelMessage(this.#canonicalState(), candidate);
    this.#modelHistory.push(candidate);
    this.#triggerChange();
  }

  beforeAppendModelStep(messages: readonly ModelMessage[]): void {
    this.#policy?.beforeAppendModelStep(this.#canonicalState(), messages);
  }

  clearTransientInputs(): void {
    this.#transientMessages.length = 0;
  }

  rollback(snapshot: ModelMessage[]): void {
    this.#modelHistory.length = 0;
    this.#modelHistory.push(...structuredClone(snapshot));
    this.clearTransientInputs();
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

  #canonicalState() {
    return {
      compactions: this.#compactions,
      history: this.#modelHistory,
    };
  }
}

function applyCompactions(
  history: readonly ModelMessage[],
  compactions: readonly ThreadCompactionRecord[],
  transientMessages: readonly TransientModelMessage[] = []
): ModelMessage[] {
  const kept = nonOverlappedCompactions(history.length, compactions);
  if (kept.length === 0) {
    return applyTransientMessages(
      history.map((message) => structuredClone(message)),
      history.length,
      transientMessages
    );
  }

  const byStart = new Map<number, ThreadCompactionRecord>();
  for (const record of kept) {
    byStart.set(record.startSeq, record);
  }

  const output: ModelMessage[] = [];
  for (let index = 0; index < history.length; ) {
    appendTransientMessages(output, transientMessages, index);
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
  appendTransientMessages(output, transientMessages, history.length);
  return output;
}

interface TransientModelMessage {
  readonly index: number;
  readonly message: ModelMessage;
}

function applyTransientMessages(
  history: ModelMessage[],
  historyLength: number,
  transientMessages: readonly TransientModelMessage[]
): ModelMessage[] {
  if (transientMessages.length === 0) {
    return history;
  }

  const output: ModelMessage[] = [];
  for (let index = 0; index < historyLength; index += 1) {
    appendTransientMessages(output, transientMessages, index);
    const message = history[index];
    if (message) {
      output.push(message);
    }
  }
  appendTransientMessages(output, transientMessages, historyLength);
  return output;
}

function appendTransientMessages(
  output: ModelMessage[],
  transientMessages: readonly TransientModelMessage[],
  index: number
): void {
  for (const transient of transientMessages) {
    if (transient.index === index) {
      output.push(structuredClone(transient.message));
    }
  }
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
