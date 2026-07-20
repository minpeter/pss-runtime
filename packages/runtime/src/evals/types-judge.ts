import type { LanguageModel } from "ai";

import type { AssertionHandle } from "./types-assertions";

/** Options for a single judge call (per-call overrides). */
export interface JudgeCallOptions {
  /** Per-call judge model override. */
  readonly model?: LanguageModel;
  /** Value to grade; defaults to the scope's last reply. */
  readonly on?: unknown;
}

/** The autoevals grader family, mirroring Braintrust autoevals. */
export interface JudgeAutoevals {
  /** Closed-QA: does the value meet the free-form `criterion`? */
  closedQA(criterion: string, options?: JudgeCallOptions): AssertionHandle;
  /** Factual consistency of the value against an expected reference answer. */
  factuality(expected: string, options?: JudgeCallOptions): AssertionHandle;
  /** How well the value summarizes the expected reference text. */
  summarizes(expected: string, options?: JudgeCallOptions): AssertionHandle;
}

/** The `t.judge` surface: LLM-graded assertions (the only model-backed ones). */
export interface JudgeSurface {
  readonly autoevals: JudgeAutoevals;
}
