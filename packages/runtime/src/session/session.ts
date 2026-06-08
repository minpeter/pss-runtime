import type { RuntimeLlm } from "../llm";
import type { AgentPlugin } from "../plugins";
import type { AgentEvent } from "./events";
import type { AgentInput, UserInput } from "./input";
import { normalizeAgentInput } from "./input-normalization";
import { type AgentRun, BufferedAgentRun } from "./run";
import {
  addSteeringInput,
  createRuntimeInputState,
  type QueuedInput,
  type QueuedRuntimeInput,
  queueRuntimeInput,
  type RuntimeInputPlacement,
  type RuntimeInputState,
} from "./runtime-input";
import { sessionKilledError, sessionTerminalError } from "./session-errors";
import { SessionEventDispatcher } from "./session-events";
import type { SessionExecutionOptions } from "./session-execution";
import { closeKilledRuntimeInputs } from "./session-kill";
import {
  type NotifyOptions,
  queueSessionNotification,
  startSessionQueueDrain,
} from "./session-notification";
import { type SessionPersistenceOptions, SessionState } from "./session-state";
import { processQueuedInput } from "./session-turn-processor";

export type { AgentInput, SessionInput, UserInput } from "./input";
export type { AgentRun } from "./run";
export type { NotifyOptions } from "./session-notification";

export class AgentSession {
  readonly #events: SessionEventDispatcher;
  readonly #execution: SessionExecutionOptions;
  readonly #inputQueue: QueuedInput[] = [];
  readonly #llm: RuntimeLlm;
  readonly #pendingRuntimeInputs: QueuedRuntimeInput[] = [];
  readonly #sessionKey: string;
  readonly #state: SessionState;
  #activeAbort?: AbortController;
  #activeRun?: BufferedAgentRun;
  #activeRuntimeInput?: RuntimeInputState;
  #activeTurnId?: string;
  #deletePromise?: Promise<void>;
  #killed = false;
  #running = false;
  #runToCloseOnKill?: BufferedAgentRun;

  constructor(
    llm: RuntimeLlm,
    persistence: SessionPersistenceOptions,
    plugins: readonly AgentPlugin[] = [],
    execution: SessionExecutionOptions = {}
  ) {
    this.#llm = llm;
    this.#execution = execution;
    this.#sessionKey = persistence.key;
    this.#state = new SessionState(persistence);
    this.#events = new SessionEventDispatcher({
      history: () => this.#state.modelSnapshot(),
      plugins,
      signal: () => this.#activeAbort?.signal,
    });
  }

  async send(input: AgentInput): Promise<AgentRun> {
    if (this.#killed || this.#deletePromise) {
      throw sessionTerminalError(this.#killed);
    }

    await this.#state.ensureLoaded();

    if (this.#killed || this.#deletePromise) {
      throw sessionTerminalError(this.#killed);
    }

    const runtimeInput = createRuntimeInputState(
      this.#pendingRuntimeInputs.splice(0)
    );
    const acceptedInput = normalizeAgentInput(input);
    const run = new BufferedAgentRun();
    await this.#events.emitRunEvent(run, acceptedInput);
    this.#inputQueue.push({
      initialEvents: [],
      input: structuredClone(acceptedInput),
      preUserRuntimeInputs: [],
      run,
      runtimeInput,
    });
    startSessionQueueDrain(run, () => this.#drainInputQueue());
    return run;
  }

  async notify(
    input: AgentInput,
    options: NotifyOptions = {}
  ): Promise<AgentRun> {
    if (this.#killed || this.#deletePromise) {
      throw sessionTerminalError(this.#killed);
    }

    await this.#state.ensureLoaded();

    if (this.#killed || this.#deletePromise) {
      throw sessionTerminalError(this.#killed);
    }

    return queueSessionNotification(input, options, {
      activeRun: this.#activeRun,
      activeRuntimeInput: this.#activeRuntimeInput,
      drain: () => this.#drainInputQueue(),
      inputQueue: this.#inputQueue,
      pendingRuntimeInputs: this.#pendingRuntimeInputs,
    });
  }

  async steer(input: AgentInput): Promise<AgentRun> {
    if (this.#killed || this.#deletePromise) {
      throw sessionTerminalError(this.#killed);
    }

    const runtimeInput = this.#activeRuntimeInput;
    const run = this.#activeRun;
    if (!(runtimeInput && run)) {
      return this.send(input);
    }

    await addSteeringInput(runtimeInput, input);
    return run;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  currentTurnId(): string | undefined {
    return this.#activeTurnId;
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

  enqueueRuntimeInput(
    input: UserInput,
    placement: RuntimeInputPlacement = "turn-start"
  ): void {
    if (this.#killed) {
      return;
    }

    const runtimeInput = this.#activeRuntimeInput;
    if (runtimeInput && !runtimeInput.closedReason) {
      if (placement === "turn-start" && runtimeInput.placement !== placement) {
        this.#enqueuePendingRuntimeInput({ input, placement });
        return;
      }

      queueRuntimeInput(runtimeInput, { input, placement });
      return;
    }

    this.#enqueuePendingRuntimeInput({ input, placement });
  }

  emitObserverEvent(event: AgentEvent): Promise<void> {
    return this.#events.emitObserverEvent(this.#activeRun, event);
  }

  #enqueuePendingRuntimeInput(input: QueuedRuntimeInput): void {
    const queuedTurn = this.#inputQueue[0];
    if (input.placement === "turn-start" && queuedTurn) {
      queueRuntimeInput(queuedTurn.runtimeInput, input);
      return;
    }

    this.#pendingRuntimeInputs.push(input);
  }

  kill(): void {
    if (this.#killed) {
      return;
    }

    this.#killed = true;
    const killedError = sessionKilledError();
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
            activate: ({ abort, run, runtimeInput, turnId }) => {
              this.#activeAbort = abort;
              this.#activeRun = run;
              this.#activeRuntimeInput = runtimeInput;
              this.#activeTurnId = turnId;
              this.#runToCloseOnKill = run;
            },
            deactivateRun: () => {
              this.#activeRun = undefined;
              this.#activeRuntimeInput = undefined;
            },
            events: this.#events,
            execution: this.#execution,
            item,
            llm: this.#llm,
            release: () => {
              this.#activeAbort = undefined;
              this.#activeRun = undefined;
              this.#activeRuntimeInput = undefined;
              this.#activeTurnId = undefined;
              this.#runToCloseOnKill = undefined;
            },
            sessionKey: this.#sessionKey,
            state: this.#state,
          });
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
