import type {
  RuntimeToolExecutionCheckpointMetadata,
  RuntimeToolRetryPolicy,
} from "../../llm/tool-execution-types";
import type { Checkpoint } from "./checkpoint-types";

/**
 * Tool checkpoints from this version on carry the current step's journal.
 * Thread history commits each tool round at step end, so a crashed run
 * resumes from committed history plus this journal: every result the step
 * finished and every call whose intent was recorded without an outcome.
 */
export const TOOL_STEP_JOURNAL_VERSION = 2;

/** A tool call whose intent was recorded and whose outcome is unknown. */
export interface JournaledToolIntent
  extends RuntimeToolExecutionCheckpointMetadata {
  /** Input the model generated for the call. */
  readonly input: unknown;
  /** Order in which the step recorded the call. */
  readonly seq: number;
}

/** A finished tool call of the current step, not yet in committed history. */
export interface JournaledToolResult {
  /** Version of the after-tool checkpoint that recorded the result. */
  readonly checkpointVersion: number;
  /** Error text the model received when the call failed. */
  readonly errorText?: string;
  readonly input: unknown;
  /** Output the model received; absent when the call failed. */
  readonly output?: unknown;
  /**
   * Same-id tool results in history before this one was appended. Provider
   * ids can recur, so the result is committed once committed history holds
   * more.
   */
  readonly priorResultCount: number;
  readonly seq: number;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface ToolStepJournal {
  readonly inflight: readonly JournaledToolIntent[];
  readonly results: readonly JournaledToolResult[];
  /** Entries that could not be read; recovery must fail closed. */
  readonly unreadable: number;
}

/** A recorded tool call without an outcome, in any checkpoint format. */
export type PendingToolCall = RuntimeToolExecutionCheckpointMetadata;

const RETRY_POLICIES: Record<RuntimeToolRetryPolicy, true> = {
  idempotent: true,
  "manual-recovery": true,
  pure: true,
};

/** The step journal of a tool checkpoint; `undefined` for other formats. */
export function toolStepJournal(
  checkpoint: Checkpoint | null
): ToolStepJournal | undefined {
  if (
    checkpoint?.phase !== "before-tool" &&
    checkpoint?.phase !== "after-tool"
  ) {
    return;
  }
  const state = checkpoint.runtimeState as Record<string, unknown> | null;
  if (state?.journalVersion !== TOOL_STEP_JOURNAL_VERSION) {
    return;
  }
  const inflightEntries = Array.isArray(state.inflight) ? state.inflight : [];
  const resultEntries = Array.isArray(state.results) ? state.results : [];
  const inflight = inflightEntries.flatMap((entry) => {
    const intent = parseIntent(entry);
    return intent ? [intent] : [];
  });
  const results = resultEntries.flatMap((entry) => {
    const result = parseResult(entry);
    return result ? [result] : [];
  });
  const missingLists =
    Array.isArray(state.inflight) && Array.isArray(state.results) ? 0 : 1;
  return {
    inflight,
    results,
    unreadable:
      inflightEntries.length -
      inflight.length +
      resultEntries.length -
      results.length +
      missingLists,
  };
}

/** Recorded tool calls of a run's latest checkpoint that have no outcome. */
export function pendingToolCalls(
  checkpoint: Checkpoint | null
): readonly PendingToolCall[] {
  const journal = toolStepJournal(checkpoint);
  if (journal) {
    return journal.inflight.map(toolCallMetadata);
  }
  if (checkpoint?.phase !== "before-tool") {
    return [];
  }
  const pending = toolCallMetadataOf(checkpoint.pendingToolCall);
  return pending ? [pending] : [];
}

function parseIntent(entry: unknown): JournaledToolIntent | undefined {
  const metadata = toolCallMetadataOf(entry);
  if (!metadata) {
    return;
  }
  const value = entry as Record<string, unknown>;
  if (typeof value.seq !== "number" || !("input" in value)) {
    return;
  }
  return { ...metadata, input: value.input, seq: value.seq };
}

function parseResult(entry: unknown): JournaledToolResult | undefined {
  if (typeof entry !== "object" || entry === null) {
    return;
  }
  const value = entry as Record<string, unknown>;
  if (
    typeof value.checkpointVersion !== "number" ||
    typeof value.priorResultCount !== "number" ||
    typeof value.seq !== "number" ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    !("input" in value)
  ) {
    return;
  }
  const common = {
    checkpointVersion: value.checkpointVersion,
    input: value.input,
    priorResultCount: value.priorResultCount,
    seq: value.seq,
    toolCallId: value.toolCallId,
    toolName: value.toolName,
  };
  if (typeof value.errorText === "string") {
    return { ...common, errorText: value.errorText };
  }
  return "output" in value ? { ...common, output: value.output } : undefined;
}

function toolCallMetadataOf(entry: unknown): PendingToolCall | undefined {
  if (typeof entry !== "object" || entry === null) {
    return;
  }
  const value = entry as Record<string, unknown>;
  if (
    typeof value.attempt !== "number" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.policy !== "string" ||
    !Object.hasOwn(RETRY_POLICIES, value.policy) ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string"
  ) {
    return;
  }
  return {
    attempt: value.attempt,
    idempotencyKey: value.idempotencyKey,
    policy: value.policy as RuntimeToolRetryPolicy,
    toolCallId: value.toolCallId,
    toolName: value.toolName,
  };
}

function toolCallMetadata(intent: JournaledToolIntent): PendingToolCall {
  return {
    attempt: intent.attempt,
    idempotencyKey: intent.idempotencyKey,
    policy: intent.policy,
    toolCallId: intent.toolCallId,
    toolName: intent.toolName,
  };
}
