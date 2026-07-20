import type { EvalCacheStats, EvalRun } from "./types";
import type { AssertionRecord } from "./types-assertions";

/** The outcome of one case within a run. */
export interface CaseResult {
  readonly assertions: readonly AssertionRecord[];
  /** Cache totals across every `t.run()` in this case. */
  readonly cache: EvalCacheStats;
  readonly durationMs: number;
  /** Non-assertion exception thrown by the case body. */
  readonly error?: string;
  readonly evalId: string;
  readonly name: string;
  /** Gate-based pass (plus strict softs when run under `--strict`). */
  readonly passed: boolean;
  /** Per-`t.run()` traces, suitable for JSON report inspection. */
  readonly runs: readonly EvalRun[];
  /** True when a soft assertion missed its bar (tracked, non-fatal unless strict). */
  readonly scored: boolean;
}

/** The full result of a {@link runEvals} invocation. */
export interface EvalReport {
  /** Cache totals across all selected cases. */
  readonly cache: EvalCacheStats;
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
