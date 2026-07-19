import type { ModelContextGateOptions } from "../../llm/context-gate";
import type { ThreadContextMessage } from "../state/context";
import type { ThreadCompactionInput } from "../state/thread-state";

export interface ThreadAutoCompactionOptions {
  readonly background?: boolean;
  readonly contextGate?: false | ModelContextGateOptions;
  readonly minMessages: number;
  readonly retainMessages: number;
}

export type ThreadModelContextTransform = (
  messages: readonly ThreadContextMessage[],
  signal: AbortSignal
) => Promise<readonly ThreadContextMessage[]>;

export interface AutoCompactionRange {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
}

export type ThreadCompactionHandler = (
  input: ThreadCompactionInput
) => Promise<boolean>;
