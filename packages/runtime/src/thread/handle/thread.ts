import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import type { ModelGenerationOptions } from "../../llm/llm";
import type { AgentInput, UserInput } from "../input/input";
import type {
  QueuedInput,
  QueuedRuntimeInput,
  RuntimeInputState,
} from "../input/runtime-input";
import type { AgentPlugin } from "../plugins/pipeline";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import { ThreadEventDispatcher } from "../runtime/events";
import type { ThreadExecutionOptions } from "../runtime/execution";
import { closeKilledRuntimeInputs } from "../runtime/kill";
import {
  type NotifyOptions,
  queueThreadNotification,
} from "../runtime/notification";
import { threadKilledError, threadTerminalError } from "../state/thread-errors";
import {
  type ThreadCompactionInput,
  type ThreadPersistenceOptions,
  ThreadState,
} from "../state/thread-state";
import {
  addDurableSteeringInput,
  admitThreadSendInput,
  DurableInputRecoveryState,
  recoverThreadDurableInputClaims,
} from "./durable-queue";
import { runThreadInputDrainLoop } from "./thread-drain";
import { readThreadEvents } from "./thread-event-replay";
import { createOverlayRuntimeInput } from "./thread-overlay";

export type { AgentInput, ThreadInput, UserInput } from "../input/input";
export type { AgentTurn } from "../protocol/turn";
export type { NotifyOptions } from "../runtime/notification";
export type { ThreadCompactionInput } from "../state/thread-state";

export class AgentThread {
  readonly #events: ThreadEventDispatcher;
  readonly #execution: ThreadExecutionOptions;
  readonly #inputQueue: QueuedInput[] = [];
  readonly #model: ModelGenerationOptions;
  readonly #pendingOverlays: QueuedRuntimeInput[] = [];
  readonly #durableInputRecovery = new DurableInputRecoveryState();
  readonly #pendingRuntimeInputs: QueuedRuntimeInput[] = [];
  readonly #threadKey: string;
  readonly #state: ThreadState;
  #activeAbort?: AbortController;
  #activeRun?: BufferedAgentTurn;
  #activeRuntimeInput?: RuntimeInputState;
  #deletePromise?: Promise<void>;
  #drainPromise?: Promise<void>;
  #drainRequested = false;
  #inputAdmissionQueue: Promise<void> = Promise.resolve();
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
      attachmentStore: model.attachmentStore,
      history: () => this.#state.modelSnapshot(),
      plugins,
      signal: () => this.#activeAbort?.signal,
    });
  }

  async send(input: AgentInput): Promise<AgentTurn> {
    this.#assertOpen();

    const run = new BufferedAgentTurn();
    const loaded = this.#state.ensureLoaded();
    await this.#enqueueInputAdmission(async () => {
      await loaded;
      await this.#admitSend(input, run);
    });
    return run;
  }

  async #admitSend(input: AgentInput, run: BufferedAgentTurn): Promise<void> {
    this.#assertOpen();

    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    await admitThreadSendInput({
      awaitBoundaries: !(this.#running && !this.#activeRun),
      drain: () => this.#drainInputQueue(),
      events: this.#events,
      executionHost: this.#execution.executionHost,
      attachmentStore: this.#model.attachmentStore,
      input,
      inputQueue: this.#inputQueue,
      pendingOverlays: this.#pendingOverlays,
      pendingRuntimeInputs: this.#pendingRuntimeInputs,
      run,
      threadKey: this.#threadKey,
    });
  }

  overlay(input: AgentInput): this {
    this.#assertOpen();

    this.#pendingOverlays.push(createOverlayRuntimeInput(input));
    return this;
  }

  async notify(
    input: AgentInput | UserInput,
    options: NotifyOptions = {}
  ): Promise<AgentTurn> {
    this.#assertOpen();

    await this.#state.ensureLoaded();
    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    return queueThreadNotification(input, options, {
      activeRun: this.#activeRun,
      activeRuntimeInput: this.#activeRuntimeInput,
      attachmentStore: this.#model.attachmentStore,
      drain: () => this.#drainInputQueue(),
      emitObserverEvent: (run, event) =>
        this.#events.emitObserverEvent(run, event),
      inputQueue: this.#inputQueue,
      pendingRuntimeInputs: this.#pendingRuntimeInputs,
    });
  }

  async steer(input: AgentInput): Promise<AgentTurn> {
    this.#assertOpen();

    const runtimeInput = this.#activeRuntimeInput;
    const run = this.#activeRun;
    if (!(runtimeInput && run)) {
      return this.send(input);
    }

    await addDurableSteeringInput({
      executionHost: this.#execution.executionHost,
      attachmentStore: this.#model.attachmentStore,
      input,
      runtimeInput,
      threadKey: this.#threadKey,
    });
    return run;
  }

  async compact(input: ThreadCompactionInput): Promise<void> {
    this.#assertOpen();

    await this.#state.ensureLoaded();
    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    await this.#state.compact(input);
  }

  events(options?: ThreadEventReadOptions): AsyncIterable<StoredThreadEvent> {
    return readThreadEvents(this.#execution, this.#threadKey, options);
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  #assertOpen(): void {
    if (this.#killed || this.#deletePromise) {
      throw threadTerminalError(this.#killed);
    }
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
    this.#pendingOverlays.length = 0;
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
      this.#drainRequested = true;
      return await (this.#drainPromise ?? Promise.resolve());
    }

    this.#running = true;
    this.#drainRequested = false;
    const drain = runThreadInputDrainLoop({
      activate: ({ abort, run, runtimeInput }) => {
        this.#activeAbort = abort;
        this.#activeRun = run;
        this.#activeRuntimeInput = runtimeInput;
        this.#runToCloseOnKill = run;
      },
      continueDraining: () => !(this.#killed || this.#drainRequested),
      deactivateRun: () => {
        this.#activeRun = undefined;
        this.#activeRuntimeInput = undefined;
      },
      events: this.#events,
      execution: this.#execution,
      inputQueue: this.#inputQueue,
      model: this.#model,
      release: () => {
        this.#activeAbort = undefined;
        this.#activeRun = undefined;
        this.#activeRuntimeInput = undefined;
        this.#runToCloseOnKill = undefined;
      },
      state: this.#state,
      threadKey: this.#threadKey,
    });
    this.#drainPromise = drain;
    try {
      await drain;
    } finally {
      const shouldRestart = this.#drainRequested && !this.#killed;
      this.#running = false;
      this.#drainPromise = undefined;
      if (shouldRestart) {
        this.#drainRequested = false;
        await this.#drainInputQueue();
      }
    }
  }

  async #enqueueInputAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#inputAdmissionQueue.then(operation, operation);
    this.#inputAdmissionQueue = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  }

  async #recoverDurableInputClaims(): Promise<void> {
    await recoverThreadDurableInputClaims({
      executionHost: this.#execution.executionHost,
      state: this.#durableInputRecovery,
      threadKey: this.#threadKey,
    });
  }
}
