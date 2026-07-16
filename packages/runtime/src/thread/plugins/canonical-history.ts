import type { ModelMessage } from "ai";
import {
  type ThreadCompactionRecord,
  validateThreadCompactionRecord,
} from "../state/snapshot";
import type { ExpectedThreadVersion } from "../store/types";

export interface CanonicalHistoryState {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly history: readonly ModelMessage[];
}

export interface CanonicalHistoryLoadedStateContext {
  readonly state: CanonicalHistoryState;
  readonly threadKey: string;
  readonly threadVersion: string | null;
}

export interface CanonicalHistoryAppendContext {
  readonly message: ModelMessage;
  readonly state: CanonicalHistoryState;
  readonly threadKey: string;
}

export interface CanonicalHistoryStepContext {
  readonly messages: readonly ModelMessage[];
  readonly state: CanonicalHistoryState;
  readonly threadKey: string;
}

export interface CanonicalHistoryCompactionContext {
  readonly record: ThreadCompactionRecord;
  readonly state: CanonicalHistoryState;
  readonly threadKey: string;
}

export interface CanonicalHistoryCommitContext {
  readonly expectedVersion: ExpectedThreadVersion;
  readonly state: CanonicalHistoryState;
  readonly threadKey: string;
}

export interface CanonicalHistoryModelContext {
  readonly messages: readonly ModelMessage[];
  readonly state: CanonicalHistoryState;
  readonly threadKey: string;
}

/**
 * Synchronous policy hooks for the state transitions that can affect canonical
 * model history. Hooks may throw to fail closed. Projection hooks run in plugin
 * registration order, and each returned projection becomes the input to the
 * next policy.
 */
export interface CanonicalHistoryPolicy {
  readonly beforeAppendModelMessage?: (
    context: CanonicalHistoryAppendContext
  ) => void;
  readonly beforeAppendModelStep?: (
    context: CanonicalHistoryStepContext
  ) => void;
  readonly beforeCommit?: (context: CanonicalHistoryCommitContext) => void;
  readonly beforeRecordCompaction?: (
    context: CanonicalHistoryCompactionContext
  ) => void;
  readonly projectLoadedState?: (
    context: CanonicalHistoryLoadedStateContext
  ) => CanonicalHistoryState | undefined;
  readonly projectModelContext?: (
    context: CanonicalHistoryModelContext
  ) => readonly ModelMessage[] | undefined;
}

interface MutableCanonicalHistoryState {
  readonly compactions: ThreadCompactionRecord[];
  readonly history: ModelMessage[];
}

export class CanonicalHistoryPolicyPipeline {
  readonly #policies: () => readonly CanonicalHistoryPolicy[];
  readonly #threadKey: string;

  constructor(
    threadKey: string,
    policies:
      | readonly CanonicalHistoryPolicy[]
      | (() => readonly CanonicalHistoryPolicy[]) = []
  ) {
    this.#policies = typeof policies === "function" ? policies : () => policies;
    this.#threadKey = threadKey;
  }

  get active(): boolean {
    return this.#policies().length > 0;
  }

  projectLoadedState(
    state: CanonicalHistoryState,
    threadVersion: string | null
  ): MutableCanonicalHistoryState {
    let candidate = cloneCanonicalHistoryState(state);
    for (const policy of this.#policies()) {
      const projected = policy.projectLoadedState?.({
        state: cloneCanonicalHistoryState(candidate),
        threadKey: this.#threadKey,
        threadVersion,
      });
      if (projected !== undefined) {
        candidate = cloneCanonicalHistoryState(projected);
      }
    }
    return candidate;
  }

  beforeAppendModelMessage(
    state: CanonicalHistoryState,
    message: ModelMessage
  ): void {
    for (const policy of this.#policies()) {
      policy.beforeAppendModelMessage?.({
        message: structuredClone(message),
        state: cloneCanonicalHistoryState(state),
        threadKey: this.#threadKey,
      });
    }
  }

  beforeAppendModelStep(
    state: CanonicalHistoryState,
    messages: readonly ModelMessage[]
  ): void {
    for (const policy of this.#policies()) {
      policy.beforeAppendModelStep?.({
        messages: structuredClone([...messages]),
        state: cloneCanonicalHistoryState(state),
        threadKey: this.#threadKey,
      });
    }
  }

  beforeRecordCompaction(
    state: CanonicalHistoryState,
    record: ThreadCompactionRecord
  ): void {
    for (const policy of this.#policies()) {
      policy.beforeRecordCompaction?.({
        record: structuredClone(record),
        state: cloneCanonicalHistoryState(state),
        threadKey: this.#threadKey,
      });
    }
  }

  beforeCommit(
    state: CanonicalHistoryState,
    expectedVersion: ExpectedThreadVersion
  ): void {
    for (const policy of this.#policies()) {
      policy.beforeCommit?.({
        expectedVersion,
        state: cloneCanonicalHistoryState(state),
        threadKey: this.#threadKey,
      });
    }
  }

  projectModelContext(
    state: CanonicalHistoryState,
    messages: readonly ModelMessage[]
  ): ModelMessage[] {
    let candidate = structuredClone([...messages]);
    for (const policy of this.#policies()) {
      const projected = policy.projectModelContext?.({
        messages: structuredClone(candidate),
        state: cloneCanonicalHistoryState(state),
        threadKey: this.#threadKey,
      });
      if (projected !== undefined) {
        if (!Array.isArray(projected)) {
          throw new TypeError(
            "Canonical history model-context projection must return an array."
          );
        }
        candidate = structuredClone([...projected]);
      }
    }
    return candidate;
  }
}

function cloneCanonicalHistoryState(
  state: CanonicalHistoryState
): MutableCanonicalHistoryState {
  if (!(Array.isArray(state.history) && Array.isArray(state.compactions))) {
    throw new TypeError(
      "Canonical history state must contain history and compactions arrays."
    );
  }

  const history = structuredClone([...state.history]);
  const compactions = state.compactions.map((record) =>
    validateThreadCompactionRecord(record, history.length)
  );
  return { compactions, history };
}
