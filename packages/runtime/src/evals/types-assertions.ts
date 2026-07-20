import type { StandardSchemaV1 } from "./standard-schema";

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
