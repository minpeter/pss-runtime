import type {
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { AgentInput, UserInput } from "../input/input";
import { type AgentTurn, BufferedAgentTurn } from "../protocol/turn";
import type { ThreadExecutionOptions } from "../runtime/execution";
import { closeKilledRuntimeInputs } from "../runtime/kill";
import type { NotifyOptions } from "../runtime/notification";
import { queueThreadNotification } from "../runtime/notification";
import { readThreadEvents } from "../runtime/thread-event-replay";
import { threadKilledError, threadTerminalError } from "../state/thread-errors";
import type {
  ThreadCompactionInput,
  ThreadPersistenceOptions,
} from "../state/thread-state";
import {
  type AgentThreadContext,
  createAgentThreadContext,
} from "./agent-thread-context";
import { recoverThreadDurableInputClaims } from "./durable-queue-claims";
import { admitThreadSendInput } from "./durable-queue-send";
import { addDurableSteeringInput } from "./durable-steering";
import { runThreadInputDrainLoop } from "./thread-drain";
import { createOverlayRuntimeInput } from "./thread-overlay";

export class AgentThread {
  readonly #context: AgentThreadContext;

  constructor(
    model: ModelGenerationOptions,
    persistence: ThreadPersistenceOptions,
    execution: ThreadExecutionOptions = {}
  ) {
    this.#context = createAgentThreadContext(model, persistence, execution);
  }

  async send(input: AgentInput): Promise<AgentTurn> {
    this.#assertOpen();

    const run = new BufferedAgentTurn();
    const loaded = this.#ensureStarted();
    await this.#enqueueInputAdmission(async () => {
      await loaded;
      await this.#admitSend(input, run);
    });
    return run;
  }

  overlay(input: AgentInput): this {
    this.#assertOpen();

    this.#context.pendingOverlays.push(createOverlayRuntimeInput(input));
    return this;
  }

  async notify(
    input: AgentInput | UserInput,
    options: NotifyOptions = {}
  ): Promise<AgentTurn> {
    this.#assertOpen();

    await this.#ensureStarted();
    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    return queueThreadNotification(input, options, {
      activeRun: this.#context.activeRun,
      activeRuntimeInput: this.#context.activeRuntimeInput,
      attachmentStore: this.#context.model.attachmentStore,
      drain: () => this.#drainInputQueue(),
      emitObserverEvent: (run, event) =>
        this.#context.events.emitObserverEvent(run, event),
      executionHost: this.#context.execution.executionHost,
      inputQueue: this.#context.inputQueue,
      pendingRuntimeInputs: this.#context.pendingRuntimeInputs,
      threadKey: this.#context.threadKey,
      throwIfTerminal: () => this.#assertOpen(),
    });
  }

  async steer(input: AgentInput): Promise<AgentTurn> {
    this.#assertOpen();

    const runtimeInput = this.#context.activeRuntimeInput;
    const run = this.#context.activeRun;
    if (!(runtimeInput && run)) {
      return this.send(input);
    }

    await addDurableSteeringInput({
      executionHost: this.#context.execution.executionHost,
      attachmentStore: this.#context.model.attachmentStore,
      input,
      runtimeInput,
      threadKey: this.#context.threadKey,
    });
    return run;
  }

  async compact(input: ThreadCompactionInput): Promise<void> {
    this.#assertOpen();

    await this.#ensureStarted();
    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    await this.#context.events.compact(this.#context.state, input);
  }

  events(options?: ThreadEventReadOptions): AsyncIterable<StoredThreadEvent> {
    return readThreadEvents(
      this.#context.execution,
      this.#context.threadKey,
      options
    );
  }

  interrupt(): void {
    this.#context.activeAbort?.abort();
  }

  delete(): Promise<void> {
    if (!this.#context.deletePromise) {
      this.#context.deletePromise = this.kill()
        .then(() => this.#deleteThread())
        .catch((error: unknown) => {
          this.#context.deletePromise = undefined;
          throw error;
        });
    }
    return this.#context.deletePromise;
  }

  async dispose(): Promise<void> {
    const kill = this.kill();
    try {
      await this.#context.drainPromise;
    } finally {
      await kill;
      await this.#shutdown();
    }
  }

  kill(): Promise<void> {
    if (this.#context.killed) {
      return this.#context.killPromise ?? Promise.resolve();
    }

    this.#context.killed = true;
    const killedError = threadKilledError();
    this.#context.pendingOverlays.length = 0;
    this.#context.pendingRuntimeInputs.length = 0;
    this.#context.activeAbort?.abort();
    const immediateClose = closeKilledRuntimeInputs({
      activeRuntimeInput: this.#context.activeRuntimeInput,
      executionHost: this.#context.execution.executionHost,
      inputQueue: this.#context.inputQueue,
      message: killedError.message,
      runToClose: this.#context.runToCloseOnKill ?? this.#context.activeRun,
      threadKey: this.#context.threadKey,
    });
    const admissionClose = this.#context.inputAdmissionQueue.then(() =>
      closeKilledRuntimeInputs({
        activeRuntimeInput: undefined,
        executionHost: this.#context.execution.executionHost,
        inputQueue: this.#context.inputQueue,
        message: killedError.message,
        runToClose: undefined,
        threadKey: this.#context.threadKey,
      })
    );
    this.#context.killPromise = Promise.all([
      immediateClose,
      admissionClose,
    ]).then(() => undefined);
    this.#context.killPromise.catch(() => undefined);
    return this.#context.killPromise;
  }

  async #admitSend(input: AgentInput, run: BufferedAgentTurn): Promise<void> {
    this.#assertOpen();

    await this.#recoverDurableInputClaims();

    this.#assertOpen();

    await admitThreadSendInput({
      awaitBoundaries: !(this.#context.running && !this.#context.activeRun),
      drain: () => this.#drainInputQueue(),
      events: this.#context.events,
      executionHost: this.#context.execution.executionHost,
      attachmentStore: this.#context.model.attachmentStore,
      input,
      inputQueue: this.#context.inputQueue,
      pendingOverlays: this.#context.pendingOverlays,
      pendingRuntimeInputs: this.#context.pendingRuntimeInputs,
      run,
      threadKey: this.#context.threadKey,
    });
    this.#assertOpen();
  }

  async #enqueueInputAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#context.inputAdmissionQueue.then(operation, operation);
    this.#context.inputAdmissionQueue = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  }

  async #recoverDurableInputClaims(): Promise<void> {
    await recoverThreadDurableInputClaims({
      executionHost: this.#context.execution.executionHost,
      state: this.#context.durableInputRecovery,
      threadKey: this.#context.threadKey,
    });
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#context.running) {
      this.#context.drainRequested = true;
      return await (this.#context.drainPromise ?? Promise.resolve());
    }

    this.#context.running = true;
    this.#context.drainRequested = false;
    const drain = runThreadInputDrainLoop({
      activate: ({ abort, run, runtimeInput }) => {
        this.#context.activeAbort = abort;
        this.#context.activeRun = run;
        this.#context.activeRuntimeInput = runtimeInput;
        this.#context.runToCloseOnKill = run;
      },
      continueDraining: () =>
        !(this.#context.killed || this.#context.drainRequested),
      deactivateRun: () => {
        this.#context.activeRun = undefined;
        this.#context.activeRuntimeInput = undefined;
      },
      events: this.#context.events,
      execution: this.#context.execution,
      inputQueue: this.#context.inputQueue,
      model: this.#context.model,
      release: () => {
        this.#context.activeAbort = undefined;
        this.#context.activeRun = undefined;
        this.#context.activeRuntimeInput = undefined;
        this.#context.runToCloseOnKill = undefined;
      },
      state: this.#context.state,
      threadKey: this.#context.threadKey,
    });
    this.#context.drainPromise = drain;
    try {
      await drain;
    } finally {
      const shouldRestart =
        this.#context.drainRequested && !this.#context.killed;
      this.#context.running = false;
      this.#context.drainPromise = undefined;
      if (shouldRestart) {
        this.#context.drainRequested = false;
        await this.#drainInputQueue();
      }
    }
  }

  #assertOpen(): void {
    if (this.#context.killed || this.#context.deletePromise) {
      throw threadTerminalError(this.#context.killed);
    }
  }

  #ensureStarted(): Promise<void> {
    this.#context.startPromise ??= this.#context.state
      .ensureLoaded()
      .then(async () => {
        await this.#context.events.startThread();
        this.#context.started = true;
      });
    return this.#context.startPromise;
  }

  async #deleteThread(): Promise<void> {
    await this.#shutdown();
    await this.#context.state.delete();
  }

  async #shutdown(): Promise<void> {
    if (this.#context.shutdownPromise) {
      return await this.#context.shutdownPromise;
    }
    if (!this.#context.startPromise) {
      return;
    }
    this.#context.shutdownPromise = this.#context.startPromise.then(
      async () => {
        if (!this.#context.started) {
          return;
        }
        await this.#context.events.shutdownThread();
        this.#context.started = false;
      }
    );
    return await this.#context.shutdownPromise;
  }
}
