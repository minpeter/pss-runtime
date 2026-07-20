import type { LanguageModel } from "ai";
import type { AgentEvent, ModelUsage } from "../thread/protocol/events";
import type {
  AssertionHandle,
  SchemaInput,
  ToolCallMatcherOptions,
  ValueBuilder,
} from "./types-assertions";
import type { JudgeSurface } from "./types-judge";

type MaybePromise<T> = PromiseLike<T> | T;

export type { AgentEvent } from "../thread/protocol/events";
export type {
  AssertionHandle,
  AssertionRecord,
  AssertionSeverity,
  FieldMatcher,
  SchemaInput,
  ToolCallMatcherOptions,
  ValueBuilder,
} from "./types-assertions";
export type {
  JudgeAutoevals,
  JudgeCallOptions,
  JudgeSurface,
} from "./types-judge";

/**
 * A normalized view of a single agent turn, distilled from the real
 * {@link AgentEvent} stream emitted by the runtime. Eval scopes accumulate
 * these across multi-turn cases and assert against the aggregated state.
 */
export interface EvalRun {
  /** Aggregate prompt-cache telemetry for this turn. */
  readonly cache: EvalCacheStats;
  /** Set when the turn ended in an unrecoverable runtime failure. */
  readonly error?: string;
  /** The raw runtime events, for advanced assertions or debugging. */
  readonly events: readonly AgentEvent[];
  /** User input that drove this turn. */
  readonly input: string;
  /** One usage record per successful agent-loop attempt, in attempt order. */
  readonly modelUsage: readonly ModelUsage[];
  /** Visible assistant text, concatenated across the turn. */
  readonly output: string;
  /** Every tool the model requested, in call order. */
  readonly toolCalls: readonly EvalToolCall[];
  /** Every tool result that came back, in completion order. */
  readonly toolResults: readonly EvalToolResult[];
}

/**
 * Provider-reported cache totals. The hit rate is paired cache-read tokens
 * divided by paired input tokens and exists only when tracked input is nonzero.
 */
export interface EvalCacheStats {
  /** Runtime model attempts that reached `step-start`. */
  readonly attemptedRequests: number;
  readonly cacheHitRate?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Extra `model-usage` records that reused an already observed `attemptId`. */
  readonly duplicateUsageRecords: number;
  /** Attempts that ended without a `model-usage` record (failed or aborted). */
  readonly failedRequests: number;
  readonly inputTokens?: number;
  /** Requests that reported both read and input counts but not a valid pair. */
  readonly invalidPairedRequests: number;
  readonly noCacheTokens?: number;
  /** Attempts that produced a `model-usage` record. */
  readonly successfulRequests: number;
  /** Fraction of attempts with a valid paired cache-read/input observation. */
  readonly telemetryCoverage?: number;
  /** Cache-read tokens from requests used in `cacheHitRate`. */
  readonly trackedCacheReadTokens?: number;
  /** Input tokens from requests used in `cacheHitRate`. */
  readonly trackedInputTokens?: number;
  readonly trackedRequests: number;
}

export interface CacheUsageSummaryOptions {
  /**
   * Runtime model attempts represented by the summary. Defaults to the number
   * of supplied successful usage records for standalone callers.
   */
  readonly attemptedRequests?: number;
}

export interface CacheHitRateOptions {
  /** Require this fraction of post-warmup attempts to have a valid token pair. */
  readonly minTelemetryCoverage?: number;
  /** Require at least this many attempts with both input and cache-read counts. */
  readonly minTrackedRequests?: number;
  /** Exclude this many initial `t.run()` calls from the steady-state rate. */
  readonly warmupRuns?: number;
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
  readonly judge?: { readonly model: () => LanguageModel };
  readonly tags: readonly string[];
  readonly thread: () => MaybePromise<EvalThreadLike>;
}

/** A single named check inside an eval. Receives the recording scope `t`. */
export interface EvalCase {
  readonly fn: (t: EvalScope) => Promise<void> | void;
  readonly name: string;
}

/** Options passed to {@link defineEval}. */
export interface EvalOptions {
  /**
   * Per-eval judge model factory, used by `t.judge.*`. Resolved separately from
   * the agent under test. Calling `t.judge.*` with no judge model records a
   * failed gate.
   */
  readonly judge?: { readonly model: () => LanguageModel };
  /** Optional tags, selectable from the CLI with `--tag`. */
  readonly tags?: readonly string[];
  /**
   * Factory returning a fresh agent thread for each case. Building per case
   * keeps conversation state isolated between checks.
   */
  readonly thread: () => MaybePromise<EvalThreadLike>;
}

/**
 * The recording scope handed to each case. Drive turns with `run`, then assert
 * against the aggregated run state. Assertions RECORD results rather than
 * throwing, so a single run reports every failing assertion.
 */
export interface EvalScope {
  /** Provider-reported cache totals across all completed `run` calls. */
  readonly cache: EvalCacheStats;
  /** Require a steady-state cacheReadTokens / inputTokens rate between 0 and 1. */
  cacheHitRateAtLeast(
    minimum: number,
    options?: CacheHitRateOptions
  ): AssertionHandle;
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

  /** LLM-graded assertions (soft by default; resolved judge model, never the agent). */
  readonly judge: JudgeSurface;
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
