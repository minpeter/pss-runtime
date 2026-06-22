import type { ModelGenerationOptions } from "../../llm/llm";
import type { AgentInput } from "../input/input";
import { attachInputMeta, userInputFromEvent } from "../input/input-meta";
import { normalizeAgentInput } from "../input/input-normalization";
import {
  addSteeringInput,
  createRuntimeInputState,
  type QueuedInput,
  type QueuedRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import type { AgentPlugin } from "../plugins/pipeline";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import { ThreadEventDispatcher } from "../runtime/events";
import type { ThreadExecutionOptions } from "../runtime/execution";
import { closeKilledRuntimeInputs } from "../runtime/kill";
import {
  type NotifyOptions,
  queueThreadNotification,
  startThreadQueueDrain,
} from "../runtime/notification";
import { processQueuedInput } from "../runtime/turn-processor";
import { threadKilledError, threadTerminalError } from "../state/thread-errors";
import {
  type ThreadCompactionInput,
  type ThreadPersistenceOptions,
  ThreadState,
} from "../state/thread-state";

export type { AgentInput, ThreadInput, UserInput } from "../input/input";
export type { AgentTurn } from "../protocol/turn";
export type { NotifyOptions } from "../runtime/notification";
export type { ThreadCompactionInput } from "../state/thread-state";

export class AgentThread {
  readonly #events: ThreadEventDispatcher;
  readonly #execution: ThreadExecutionOptions;
  readonly #inputQueue: QueuedInput[] = [];
  readonly #model: ModelGenerationOptions;
  readonly #pendingRuntimeInputs: QueuedRuntimeInput[] = [];
  readonly #threadKey: string;
  readonly #state: ThreadState;
  #activeAbort?: AbortController;
  #activeRun?: BufferedAgentTurn;
  #activeRuntimeInput?: RuntimeInputState;
  #deletePromise?: Promise<void>;
  #killed = false;
  #running = false;
  #runToCloseOnKill?: BufferedAgentTurn;

  constructor(
    model: ModelGenerationOptions,
    persistence: ThreadPersistenceOptions,
    plugins: readonly AgentPlugin[] = [],
    execution: ThreadExecutionOptions = {}
  ) {
    this.#model = model;
    this.#execution = execution;
    this.#threadKey = persistence.key;
    this.#state = new ThreadState(persistence);
    this.#events = new ThreadEventDispatcher({
      history: () => this.#state.modelSnapshot(),
      plugins,
      signal: () => this.#activeAbort?.signal,
    });
  }

  async send(input: AgentInput): Promise<AgentTurn> {
    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }

    await this.#state.ensureLoaded();

    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }

    const runtimeInput = createRuntimeInputState(
      this.#pendingRuntimeInputs.splice(0)
    );
    const normalized = normalizeAgentInput(input);
    const acceptedInput =
      normalized.meta === undefined
        ? attachInputMeta(normalized, { source: "send" })
        : normalized;
    const run = new BufferedAgentTurn();
    const emitted = await this.#events.emitRunEvent(run, acceptedInput);
    if (emitted === "handled") {
      run.close();
      return run;
    }

    const queuedInput = userInputFromEvent(
      emitted.type === "user-text" || emitted.type === "user-message"
        ? emitted
        : acceptedInput
    );
    this.#inputQueue.push({
      initialEvents: [],
      input: structuredClone(queuedInput),
      preUserRuntimeInputs: [],
      run,
      runtimeInput,
    });
    startThreadQueueDrain(run, () => this.#drainInputQueue());
    return run;
  }

  async notify(
    input: AgentInput,
    options: NotifyOptions = {}
  ): Promise<AgentTurn> {
    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }

    await this.#state.ensureLoaded();

    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }

    return queueThreadNotification(input, options, {
      activeRun: this.#activeRun,
      activeRuntimeInput: this.#activeRuntimeInput,
      drain: () => this.#drainInputQueue(),
      emitObserverEvent: (run, event) =>
        this.#events.emitObserverEvent(run, event),
      inputQueue: this.#inputQueue,
      pendingRuntimeInputs: this.#pendingRuntimeInputs,
    });
  }

  async steer(input: AgentInput): Promise<AgentTurn> {
    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }

    const runtimeInput = this.#activeRuntimeInput;
    const run = this.#activeRun;
    if (!(runtimeInput && run)) {
      return this.send(input);
    }

    await addSteeringInput(runtimeInput, input);
    return run;
  }

  async compact(input: ThreadCompactionInput): Promise<void> {
    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }

    await this.#state.ensureLoaded();

    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }

    await this.#state.compact(input);
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  delete(): Promise<void> {
    if (!this.#deletePromise) {
      this.kill();
      this.#deletePromise = this.#state.delete().catch((error: unknown) => {
        this.#deletePromise = undefined;
        throw error;
      });
    }
    return this.#deletePromise;
  }

  kill(): void {
    if (this.#killed) {
      return;
    }

    this.#killed = true;
    const killedError = threadKilledError();
    this.#pendingRuntimeInputs.length = 0;
    this.#activeAbort?.abort();
    closeKilledRuntimeInputs({
      activeRuntimeInput: this.#activeRuntimeInput,
      inputQueue: this.#inputQueue,
      message: killedError.message,
      runToClose: this.#runToCloseOnKill ?? this.#activeRun,
    });
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;
    try {
      while (!this.#killed && this.#inputQueue.length > 0) {
        const item = this.#inputQueue.shift();
        if (item) {
          await processQueuedInput({
            activate: ({ abort, run, runtimeInput }) => {
              this.#activeAbort = abort;
              this.#activeRun = run;
              this.#activeRuntimeInput = runtimeInput;
              this.#runToCloseOnKill = run;
            },
            deactivateRun: () => {
              this.#activeRun = undefined;
              this.#activeRuntimeInput = undefined;
            },
            events: this.#events,
            execution: this.#execution,
            item,
            model: this.#model,
            release: () => {
              this.#activeAbort = undefined;
              this.#activeRun = undefined;
              this.#activeRuntimeInput = undefined;
              this.#runToCloseOnKill = undefined;
            },
            threadKey: this.#threadKey,
            state: this.#state,
          });
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
