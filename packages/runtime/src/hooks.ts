import type { RuntimeLlmContext } from "./llm";
import type { UserInput } from "./session/session";

export type AgentTurnResult = "aborted" | "completed";
export type AgentStepResult = "completed" | "continue";
type MaybePromise<T> = PromiseLike<T> | T;

export interface AgentBeforeTurnContext {
  readonly history: RuntimeLlmContext["history"];
  readonly input: UserInput;
  readonly signal: AbortSignal;
}

export interface AgentAfterTurnContext extends AgentBeforeTurnContext {
  readonly result: AgentTurnResult;
}

export interface AgentBeforeStepContext {
  readonly history: RuntimeLlmContext["history"];
  readonly signal: AbortSignal;
  readonly stepIndex: number;
}

export interface AgentAfterStepContext extends AgentBeforeStepContext {
  readonly result: AgentStepResult;
}

export interface AgentHooks {
  afterStep?(context: AgentAfterStepContext): MaybePromise<void>;
  afterTurn?(context: AgentAfterTurnContext): MaybePromise<void>;
  beforeStep?(context: AgentBeforeStepContext): MaybePromise<void>;
  beforeTurn?(context: AgentBeforeTurnContext): MaybePromise<void>;
}
