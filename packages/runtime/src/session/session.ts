import { runAgentLoop } from "../agent-loop";
import type { RuntimeLlm } from "../llm";
import { type AgentPlugin, runEventPlugins } from "../plugins";
import type { AgentEvent } from "./events";
import type { AgentInput, UserInput } from "./input";
import { normalizeAgentInput } from "./input-normalization";
import { type AgentRun, BufferedAgentRun } from "./run";
import {
  addSteeringInput,
  closeRuntimeInput,
  createRuntimeInputState,
  type QueuedInput,
  type QueuedRuntimeInput,
  type RuntimeInputPlacement,
  type RuntimeInputState,
  withRuntimeInputWindow,
} from "./runtime-input";
import {
  errorMessage,
  sessionKilledError,
  sessionTerminalError,
} from "./session-errors";
import { closeKilledRuntimeInputs } from "./session-kill";
import { drainRuntimeInput } from "./session-runtime-drain";
import { type SessionPersistenceOptions, SessionState } from "./session-state";
import { emitTurnErrorAfterRecovery } from "./session-turn-error";

export type { AgentInput, SessionInput, UserInput } from "./input";
export type { AgentRun } from "./run";

export class AgentSession {
  readonly #inputQueue: QueuedInput[] = [];
  readonly #llm: RuntimeLlm;
  readonly #pendingRuntimeInputs: QueuedRuntimeInput[] = [];
  readonly #plugins: readonly AgentPlugin[];
  readonly #state: SessionState;
  #activeAbort?: AbortController;
  #observerEventBuffer?: AgentEvent[];
  #activeRun?: BufferedAgentRun;
  #activeRuntimeInput?: RuntimeInputState;
  #deletePromise?: Promise<void>;
  #killed = false;
  #running = false;
  #runToCloseOnKill?: BufferedAgentRun;

  constructor(
    llm: RuntimeLlm,
    persistence: SessionPersistenceOptions,
    plugins: readonly AgentPlugin[] = []
  ) {
    this.#llm = llm;
    this.#plugins = plugins;
    this.#state = new SessionState(persistence);
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
    await this.#emitRunEvent(run, acceptedInput);
    this.#inputQueue.push({
      input: structuredClone(acceptedInput),
      run,
      runtimeInput,
    });
    this.#drainInputQueue().catch((error: unknown) => {
      run.emit({ type: "turn-error", message: errorMessage(error) });
      run.close();
    });
    return run;
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
    this.#deletePromise ??= this.#state.delete().then(
      () => this.kill(),
      (error: unknown) => {
        this.#deletePromise = undefined;
        throw error;
      }
    );
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

      runtimeInput.queue.push({ input, placement });
      return;
    }

    this.#enqueuePendingRuntimeInput({ input, placement });
  }

  emitObserverEvent(event: AgentEvent): Promise<void> {
    const observerEventBuffer = this.#observerEventBuffer;
    if (observerEventBuffer) {
      observerEventBuffer.push(structuredClone(event));
      return Promise.resolve();
    }

    const run = this.#activeRun;
    if (!run) {
      return Promise.resolve();
    }

    return this.#emitRunEvent(run, event);
  }

  #enqueuePendingRuntimeInput(input: QueuedRuntimeInput): void {
    const queuedTurn = this.#inputQueue[0];
    if (input.placement === "turn-start" && queuedTurn) {
      queuedTurn.runtimeInput.queue.push(input);
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
          await this.#processQueuedInput(item);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #processQueuedInput({
    input,
    run,
    runtimeInput,
  }: QueuedInput): Promise<void> {
    const activeAbort = new AbortController();
    this.#activeAbort = activeAbort;
    this.#activeRun = run;
    this.#activeRuntimeInput = runtimeInput;
    this.#runToCloseOnKill = run;
    const historySnapshot = this.#state.modelSnapshot();

    try {
      this.#state.appendUserInput(input);
      await this.#state.commit();
      await withRuntimeInputWindow(runtimeInput, "turn-start", async () => {
        await this.#emitRunBoundaryEvent(run, { type: "turn-start" });
      });
      await drainRuntimeInput({
        emit: (event) => this.#emitRunEvent(run, event),
        placement: "turn-start",
        runtimeInput,
        state: this.#state,
      });

      const result = await runAgentLoop({
        emit: async (event) => {
          if (event.type === "step-start" || event.type === "step-end") {
            await withRuntimeInputWindow(runtimeInput, event.type, async () => {
              await this.#emitRunBoundaryEvent(run, event);
            });
            const runtimeInputAdded = await drainRuntimeInput({
              emit: (runtimeInputEvent) =>
                this.#emitRunEvent(run, runtimeInputEvent),
              placement: event.type,
              runtimeInput,
              state: this.#state,
            });

            return event.type === "step-end"
              ? { runtimeInputAdded }
              : undefined;
          }

          await this.#emitRunEvent(run, event);
        },
        history: this.#state.history,
        llm: this.#llm,
        captureObserverEvents: (callback) =>
          this.#captureObserverEvents(run, callback),
        signal: activeAbort.signal,
      });

      await this.#state.commit();
      const terminalEvent = result === "aborted" ? "turn-abort" : "turn-end";
      closeRuntimeInput(runtimeInput, terminalEvent);
      this.#activeRuntimeInput = undefined;
      this.#activeRun = undefined;
      try {
        await this.#emitRunEvent(run, { type: terminalEvent });
      } catch (terminalError) {
        run.emit({ type: "turn-error", message: errorMessage(terminalError) });
        closeRuntimeInput(runtimeInput, "turn-error");
      }
    } catch (error) {
      const turnError =
        error instanceof Error ? error : new Error(String(error));
      await emitTurnErrorAfterRecovery({
        error: turnError,
        historySnapshot,
        run,
        runtimeInput,
        state: this.#state,
      });
    } finally {
      closeRuntimeInput(runtimeInput);
      this.#activeAbort = undefined;
      this.#activeRun = undefined;
      this.#activeRuntimeInput = undefined;
      this.#runToCloseOnKill = undefined;
      run.close(undefined, runtimeInput.closedReason);
    }
  }

  async #emitRunBoundaryEvent(
    run: BufferedAgentRun,
    event: AgentEvent
  ): Promise<void> {
    await runEventPlugins(this.#plugins, {
      event,
      history: this.#state.modelSnapshot(),
      signal: this.#activeAbort?.signal,
    });
    await run.emitBoundary(event);
  }

  async #emitRunEvent(run: BufferedAgentRun, event: AgentEvent): Promise<void> {
    await runEventPlugins(this.#plugins, {
      event,
      history: this.#state.modelSnapshot(),
      signal: this.#activeAbort?.signal,
    });
    run.emit(event);
  }

  async #captureObserverEvents<T>(
    run: BufferedAgentRun,
    callback: () => Promise<T>
  ): Promise<{
    readonly events: AgentEvent[];
    readonly release: () => void;
    readonly value: T;
  }> {
    const previousBuffer = this.#observerEventBuffer;
    const buffer: AgentEvent[] = [];
    this.#observerEventBuffer = buffer;
    try {
      const value = await callback();
      return {
        events: buffer,
        release: () => {
          if (this.#observerEventBuffer === buffer) {
            this.#observerEventBuffer = previousBuffer;
          }
        },
        value,
      };
    } catch (error) {
      for (const event of buffer.splice(0)) {
        await this.#emitRunEvent(run, event);
      }
      this.#observerEventBuffer = previousBuffer;
      throw error;
    }
  }
}
