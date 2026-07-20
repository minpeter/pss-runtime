import type { LanguageModel, ToolChoice, ToolSet } from "ai";
import type { ThreadContextMessage } from "../thread/state/context";

export type PreparedModelToolChoice = ToolChoice<ToolSet>;

export interface PrepareModelStepInput {
  readonly history: readonly ThreadContextMessage[];
  readonly runtimeStepIndex: number;
  readonly signal: AbortSignal;
  readonly threadKey: string;
  readonly tools: Readonly<ToolSet>;
}

export interface PrepareModelStepResult {
  readonly activeTools?: readonly string[];
  readonly model?: Exclude<LanguageModel, string>;
  readonly toolChoice?: PreparedModelToolChoice;
}

export type PrepareModelStep = (input: PrepareModelStepInput) =>
  | PrepareModelStepResult
  // biome-ignore lint/suspicious/noConfusingVoidType: async callbacks may intentionally resolve without a result.
  | PromiseLike<PrepareModelStepResult | void>
  | void;
