import type { ModelMessage } from "ai";
import type {
  ModelGenerationOptions,
  ModelStepOutput,
  ModelStepResult,
} from "../../llm/model-step-types";
import type { RuntimeToolExecutionContext } from "../../llm/tool-execution-types";
import type { AgentEvent } from "../../thread/protocol/events";
import type { ThreadContextMessage } from "../../thread/state/context";

export interface ModelHistory {
  appendModelMessage(message: ModelMessage): void;
  modelContextSnapshot(): ThreadContextMessage[];
  modelSnapshot(): ModelMessage[];
}

export interface RunAgentLoopOptions {
  captureObserverEvents?: ObserverEventCapture;
  emit: AgentLoopEventListener;
  history: ModelHistory;
  model: ModelGenerationOptions;
  runtimeState?: AgentLoopRuntimeState;
  signal?: AbortSignal;
  threadKey?: string;
  toolExecution?: RuntimeToolExecutionContext;
  transformModelContext?: (
    messages: readonly ThreadContextMessage[],
    signal: AbortSignal
  ) => Promise<readonly ThreadContextMessage[]>;
  transformModelStep?: (
    messages: ModelStepOutput,
    signal: AbortSignal
  ) => Promise<ModelStepOutput>;
}

export interface AgentLoopRuntimeState {
  runtimeStepIndex: number;
}

export type AgentLoopResult = "completed" | "aborted";

export interface AgentLoopBoundaryDecision {
  readonly runtimeInputAdded?: boolean;
}

export type AgentLoopEventListener = (
  event: AgentEvent
) =>
  | AgentLoopBoundaryDecision
  | Promise<AgentLoopBoundaryDecision | undefined>
  | undefined;

export type StepOutputResult = "aborted" | "completed" | "continue";

export interface ObserverEventCaptureResult<T> {
  readonly events: AgentEvent[];
  readonly release: () => void;
  readonly value: T;
}

export type ObserverEventCapture = <T>(
  callback: () => Promise<T>
) => Promise<ObserverEventCaptureResult<T>>;

export type CapturedModelStepOutput = ObserverEventCaptureResult<
  ModelStepResult | "aborted"
>;
