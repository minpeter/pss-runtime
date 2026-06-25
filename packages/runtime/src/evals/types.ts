import type { AgentEvent } from "../thread/protocol/events";
import type { StandardSchemaV1 } from "./standard-schema";

export type { AgentEvent } from "../thread/protocol/events";

/**
 * A normalized view of a single agent turn, distilled from the real
 * {@link AgentEvent} stream emitted by the runtime. Eval scopes accumulate
 * these across multi-turn cases and assert against the aggregated state.
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

/** The minimal thread surface the eval harness drives. Matches AgentThread. */
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

/** A single named check inside an eval. Receives the recording scope `t`. */
export interface EvalCase {
  readonly fn: (t: EvalScope) => Promise<void> | void;
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

export type AssertionSeverity = "gate" | "soft";

/** One recorded assertion result on a scope. The runner aggregates these. */
export interface AssertionRecord {
  /** Detail describing a failure. */
  readonly failure?: string;
  readonly label: string;
  /** Gate assertions are false here on a miss; soft assertions meet their bar. */
  readonly passed: boolean;
  /** 0..1 score for scored assertions (similarity). */
  readonly score?: number;
  readonly severity: AssertionSeverity;
  /** True for soft assertions: only fatal under `--strict`. */
  readonly strictOnly: boolean;
  /** Threshold for soft assertions with a bar (`.atLeast`). */
  readonly threshold?: number;
}

/**
 * Severity rides on the assertion (eve-style). Every assertion returns this
 * handle so you can override the default severity.
 */
export interface AssertionHandle {
  /** Soft with a bar: fatal under `--strict` when the score is below `threshold`. */
  atLeast(threshold: number): AssertionHandle;
  /** Hard: a miss fails the case (the default for gate assertions). */
  gate(): AssertionHandle;
  /** Tracked data; fatal only under `--strict`. With no threshold, tracked-only. */
  soft(threshold?: number): AssertionHandle;
}

/** Field-level matcher: a literal (partial-deep-match), a RegExp, or a predicate. */
export type FieldMatcher<T> = T | RegExp | ((value: T) => boolean | unknown);

/** Constraints for {@link EvalScope.calledTool}. */
export interface ToolCallMatcherOptions {
  /** Match the tool call input (partial-deep / RegExp / predicate). */
  readonly input?: FieldMatcher<unknown>;
  /**
   * Match the tool result output, joined to the call by `toolCallId`
   * (partial-deep / RegExp / predicate).
   */
  readonly output?: FieldMatcher<unknown>;
  /** Exact number of matching calls; default at least one. */
  readonly times?: number;
}

/** A value builder for {@link EvalScope.check}. */
export interface ValueBuilder<T> {
  readonly defaultSeverity: AssertionSeverity;
  readonly label: string;
  /** Score the value: `pass` plus an optional 0..1 `score` and `detail`. */
  readonly score: (value: T) => {
    pass: boolean;
    score?: number;
    detail?: string;
  };
}

/** Standard Schema input for {@link EvalScope.outputMatches}. */
export type SchemaInput = StandardSchemaV1;

/** The outcome of one case within a run. */
export interface CaseResult {
  readonly assertions: readonly AssertionRecord[];
  readonly durationMs: number;
  /** Non-assertion exception thrown by the case body. */
  readonly error?: string;
  readonly evalId: string;
  readonly name: string;
  /** Gate-based pass (plus strict softs when run under `--strict`). */
  readonly passed: boolean;
  /** True when a soft assertion missed its bar (tracked, non-fatal unless strict). */
  readonly scored: boolean;
}

/** The full result of a {@link runEvals} invocation. */
export interface EvalReport {
  readonly failed: number;
  readonly passed: number;
  readonly results: readonly CaseResult[];
  readonly startedAt: string;
  readonly strict: boolean;
  readonly total: number;
}

/** Options for {@link runEvals}. */
export interface RunEvalsOptions {
  /** Only run evals whose id matches (substring or RegExp). */
  readonly filter?: string | RegExp;
  /** Treat soft-threshold misses as failures (the `--strict` CLI mode). */
  readonly strict?: boolean;
  /** Only run evals carrying all of these tags. */
  readonly tags?: readonly string[];
}

/**
 * The recording scope handed to each case. Drive turns with `run`, then assert
 * against the aggregated run state. Assertions RECORD results rather than
 * throwing, so a single run reports every failing assertion.
 */
export interface EvalScope {
  /** A matching tool call happened, with optional input/output/times constraints. */
  calledTool(name: string, options?: ToolCallMatcherOptions): AssertionHandle;

  /** Grade an explicit value against a builder (`includes`/`equals`/`matches`/`similarity`). */
  check<T>(value: T, builder: ValueBuilder<T>): AssertionHandle;

  /** Run completed without failing (no HITL parking exists in pss-runtime). */
  completed(): AssertionHandle;
  /** No terminal failure across turns. */
  didNotFail(): AssertionHandle;
  /** Escape hatch: any predicate over the typed event stream. */
  event(
    predicate: (events: readonly AgentEvent[]) => boolean,
    label: string
  ): AssertionHandle;
  /** All runtime events across turns in this case. */
  readonly events: readonly AgentEvent[];
  /** True if any turn errored. */
  readonly failed: boolean;
  /** At most `n` tool calls. */
  maxToolCalls(n: number): AssertionHandle;
  /** Joined assistant text (the last reply) contains `token` (string or RegExp). */
  messageIncludes(token: string | RegExp): AssertionHandle;
  /** No `turn-error` events fired (best-effort: tool-error state isn't exposed by the runtime). */
  noFailedActions(): AssertionHandle;
  /** No call to `name` happened. */
  notCalledTool(name: string): AssertionHandle;
  /** Deep-equal the JSON-parsed reply against `value`. */
  outputEquals(value: unknown): AssertionHandle;
  /** Validate the JSON-parsed reply against a Standard Schema (e.g. Zod). */
  outputMatches(schema: SchemaInput): AssertionHandle;
  /** Visible text from the most recent turn. */
  readonly reply: string;
  /** Drive one turn on the case's isolated thread; multiple calls share it. */
  run(input: string): Promise<EvalRun>;
  /** All tool calls across turns in this case. */
  readonly toolCalls: readonly EvalToolCall[];
  /** Tool names appear in order across calls (other calls may interleave). */
  toolOrder(names: readonly string[]): AssertionHandle;
  /** All tool results across turns in this case. */
  readonly toolResults: readonly EvalToolResult[];
  /** No tool calls at all. */
  usedNoTools(): AssertionHandle;
}
