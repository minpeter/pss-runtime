import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { AgentInput, UserInput } from "../input/input";
import type { AgentTurn } from "../protocol/turn";
import type { ThreadExecutionOptions } from "../runtime/execution";
import type { NotifyOptions } from "../runtime/notification";
import type {
  ThreadCompactionInput,
  ThreadPersistenceOptions,
} from "../state/thread-state";
import {
  type AgentThreadContext,
  createAgentThreadContext,
} from "./agent-thread-context";
import {
  compactAgentThread,
  notifyAgentThread,
  overlayAgentThreadInput,
  sendAgentThreadInput,
  steerAgentThreadInput,
} from "./agent-thread-input";
import {
  deleteAgentThread,
  disposeAgentThread,
  interruptAgentThread,
  killAgentThread,
  readAgentThreadEvents,
} from "./agent-thread-lifecycle";

export class AgentThread {
  readonly #context: AgentThreadContext;

  constructor(
    model: ModelGenerationOptions,
    persistence: ThreadPersistenceOptions,
    execution: ThreadExecutionOptions = {}
  ) {
    this.#context = createAgentThreadContext(model, persistence, execution);
  }

  send(input: AgentInput): Promise<AgentTurn> {
    return sendAgentThreadInput(this.#context, input);
  }

  overlay(input: AgentInput): this {
    overlayAgentThreadInput(this.#context, input);
    return this;
  }

  notify(
    input: AgentInput | UserInput,
    options: NotifyOptions = {}
  ): Promise<AgentTurn> {
    return notifyAgentThread(this.#context, input, options);
  }

  steer(input: AgentInput): Promise<AgentTurn> {
    return steerAgentThreadInput(this.#context, input, () => this.send(input));
  }

  compact(input: ThreadCompactionInput): Promise<void> {
    return compactAgentThread(this.#context, input);
  }

  events(options?: ThreadEventReadOptions): AsyncIterable<StoredThreadEvent> {
    return readAgentThreadEvents(this.#context, options);
  }

  interrupt(): void {
    interruptAgentThread(this.#context);
  }

  delete(): Promise<void> {
    return deleteAgentThread(this.#context, () => this.kill());
  }

  dispose(): Promise<void> {
    return disposeAgentThread(this.#context, () => this.kill());
  }

  kill(): Promise<void> {
    return killAgentThread(this.#context);
  }
}
