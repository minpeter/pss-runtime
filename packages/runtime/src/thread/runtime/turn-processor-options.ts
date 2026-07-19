import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { QueuedInput, RuntimeInputState } from "../input/runtime-input";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadState } from "../state/thread-state";
import type { ThreadEventDispatcher } from "./thread-event-dispatcher";
import type { ThreadExecutionOptions } from "./execution";

export interface ActiveTurn {
  readonly abort: AbortController;
  readonly run: BufferedAgentTurn;
  readonly runtimeInput: RuntimeInputState;
  readonly turnId: string;
}

export interface ProcessQueuedInputOptions {
  readonly activate: (turn: ActiveTurn) => void;
  readonly deactivateRun: () => void;
  readonly events: ThreadEventDispatcher;
  readonly execution: ThreadExecutionOptions;
  readonly item: QueuedInput;
  readonly model: ModelGenerationOptions;
  readonly release: () => void;
  readonly state: ThreadState;
  readonly threadKey: string;
}
