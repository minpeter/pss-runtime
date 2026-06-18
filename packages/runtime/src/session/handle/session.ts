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
import { type AgentRun, BufferedAgentRun } from "../protocol/run";
import { SessionEventDispatcher } from "../runtime/events";
import type { SessionExecutionOptions } from "../runtime/execution";
import { closeKilledRuntimeInputs } from "../runtime/kill";
import {
  type NotifyOptions,
  queueSessionNotification,
  startSessionQueueDrain,
} from "../runtime/notification";
import { processQueuedInput } from "../runtime/turn-processor";
import {
  sessionKilledError,
  sessionTerminalError,
} from "../state/session-errors";
import {
  type SessionPersistenceOptions,
  SessionState,
} from "../state/session-state";

export type { AgentInput, SessionInput, UserInput } from "../input/input";
export type { AgentRun } from "../protocol/run";
export type { NotifyOptions } from "../runtime/notification";

export class AgentSession {
  readonly #events: SessionEventDispatcher;
  readonly #execution: SessionExecutionOptions;
  readonly #inputQueue: QueuedInput[] = [];
  readonly #model: ModelGenerationOptions;
  readonly #pendingRuntimeInputs: QueuedRuntimeInput[] = [];
  readonly #sessionKey: string;
  readonly #state: SessionState;
  #activeAbort?: AbortController;
  #activeRun?: BufferedAgentRun;
  #activeRuntimeInput?: RuntimeInputState;
  #deletePromise?: Promise<void>;
  #killed = false;
  #running = false;
  #runToCloseOnKill?: BufferedAgentRun;

  constructor(
    model: ModelGenerationOptions,
    persistence: SessionPersistenceOptions,
    plugins: readonly AgentPlugin[] = [],
    execution: SessionExecutionOptions = {}
  ) {
    this.#model = model;
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
    const normalized = normalizeAgentInput(input);
    const acceptedInput =
      normalized.meta === undefined
        ? attachInputMeta(normalized, { source: "send" })
        : normalized;
    const run = new BufferedAgentRun();
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
