import type { LanguageModel, ToolChoice, ToolSet } from "ai";
import type { RuntimeDiagnosticsSink } from "../plugins/diagnostics";
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
  | PromiseLike<PrepareModelStepResult | void>
  | void;

export interface ResolveModelStepOptions {
  readonly alwaysActiveTools?: readonly string[];
  readonly attemptId: string;
  readonly diagnostics?: RuntimeDiagnosticsSink;
  readonly history: readonly ThreadContextMessage[];
  readonly model: LanguageModel;
  readonly prepareModelStep?: PrepareModelStep;
  readonly runtimeStepIndex: number;
  readonly signal: AbortSignal;
  readonly threadKey?: string;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}

export interface ResolvedModelStepOptions {
  readonly activeTools?: readonly string[];
  readonly model: LanguageModel;
  readonly startToolCacheFingerprintReport?: () => void;
  readonly toolChoice?: PreparedModelToolChoice;
  readonly toolOrder?: readonly string[];
  readonly tools?: ToolSet;
}
