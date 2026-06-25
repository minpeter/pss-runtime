import type { AgentEvent } from "../thread/protocol/events";

/**
 * A normalized view of a single agent turn, distilled from the real
 * {@link AgentEvent} stream emitted by the runtime. Eval cases assert against
 * this shape rather than the raw event stream so the three core questions —
 * did it call the right tool, did it avoid the dangerous tool, did it say the
 * right thing — are one-liners.
 */
export interface EvalRun {
  /** Set when the turn ended in an unrecoverable runtime failure. */
  readonly error?: string;
  /** The raw runtime events, for advanced assertions or debugging. */
  readonly events: readonly AgentEvent[];
  /** Visible assistant text, concatenated across the turn. */
  readonly output: string;
  /** Every tool the model requested, in call order. */
  readonly toolCalls: readonly EvalToolCall[];
  /** Every tool result that came back, in completion order. */
  readonly toolResults: readonly EvalToolResult[];
}

export interface EvalToolCall {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface EvalToolResult {
  readonly output: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** Context handed to each eval case. `run` drives a turn on a per-case thread. */
export interface EvalCaseContext {
  /**
   * Send input to the case's isolated agent thread and return the normalized
   * run. Multiple calls within one case share the same thread, so a case can
   * drive a multi-turn conversation.
   */
  readonly run: (input: string) => Promise<EvalRun>;
}

/** A single named check inside an eval. */
export interface EvalCase {
  readonly fn: (ctx: EvalCaseContext) => Promise<void> | void;
  readonly name: string;
}

/** Options passed to {@link defineEval}. */
export interface EvalOptions {
  /** Optional tags, selectable from the CLI with `--tag`. */
  readonly tags?: readonly string[];
  /**
   * Factory returning a fresh agent thread for each case. Building per case
   * keeps conversation state isolated between checks.
   */
  readonly thread: () => EvalThreadLike;
}

/**
 * The minimal thread surface the eval harness needs. This matches
 * {@link AgentThread} but is narrowed so the harness only depends on behavior,
 * not a concrete class.
 */
export interface EvalThreadLike {
  send(input: string): Promise<AgentTurnLike>;
}

export interface AgentTurnLike {
  events(): AsyncIterable<AgentEvent>;
}

/** A registered eval: its id, options, and cases. */
export interface EvalDefinition {
  readonly cases: readonly EvalCase[];
  readonly id: string;
  readonly tags: readonly string[];
  readonly thread: () => EvalThreadLike;
}

/** The outcome of one case within a run. */
export interface CaseResult {
  readonly durationMs: number;
  readonly error?: string;
  readonly evalId: string;
  readonly name: string;
  readonly passed: boolean;
}

/** The full result of a {@link runEvals} invocation. */
export interface EvalReport {
  readonly failed: number;
  readonly passed: number;
  readonly results: readonly CaseResult[];
  readonly startedAt: string;
  readonly total: number;
}

/** Options for {@link runEvals}. */
export interface RunEvalsOptions {
  /** Only run evals whose id matches (substring or RegExp). */
  readonly filter?: string | RegExp;
  /** Only run evals carrying all of these tags. */
  readonly tags?: readonly string[];
}
