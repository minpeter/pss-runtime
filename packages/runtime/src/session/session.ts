import { runAgentLoop } from "../agent-loop";
import type { AgentHooks } from "../hooks";
import type { Llm } from "../llm";
import type { AgentEvent } from "./events";
import type { AgentInput, UserInput } from "./input";
import { normalizeAgentInput } from "./input-normalization";
import type { AgentRun } from "./run";
import { BufferedAgentRun } from "./run";
import {
  addSteeringInput,
  closeRuntimeInput,
  createRuntimeInputState,
  hooksForRuntimeInput,
  type QueuedInput,
  type QueuedRuntimeInput,
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
  withRuntimeInputWindow,
  withSteeringPlacement,
} from "./runtime-input";
import {
  errorMessage,
  runAfterTurnHook,
  sessionKilledError,
} from "./session-errors";
import type { SessionPersistenceOptions } from "./session-state";
import { SessionState } from "./session-state";
import { emitTurnErrorAfterRecovery } from "./session-turn-error";

export type { AgentInput, SessionInput, UserInput } from "./input";
export type { AgentRun } from "./run";

export class AgentSession {
  readonly #hooks?: AgentHooks;
  readonly #inputQueue: QueuedInput[] = [];
  readonly #llm: Llm;
  readonly #pendingRuntimeInputs: QueuedRuntimeInput[] = [];
  readonly #state: SessionState;
  #activeAbort?: AbortController;
  #activeRun?: BufferedAgentRun;
  #activeRuntimeInput?: RuntimeInputState;
  #killed = false;
  #running = false;
  #runToCloseOnKill?: BufferedAgentRun;

  constructor(
    llm: Llm,
    persistence: SessionPersistenceOptions,
    hooks?: AgentHooks
  ) {
    this.#hooks = hooks;
    this.#llm = llm;
    this.#state = new SessionState(persistence);
  }

  async send(input: AgentInput): Promise<AgentRun> {
    if (this.#killed) {
      throw sessionKilledError();
    }

    await this.#state.ensureLoaded();

    if (this.#killed) {
      throw sessionKilledError();
    }

    const runtimeInput = createRuntimeInputState(
      this.#pendingRuntimeInputs.splice(0)
    );
    const acceptedInput = normalizeAgentInput(input);
    const run = new BufferedAgentRun();
    run.emit(acceptedInput);
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
    if (this.#killed) {
      throw sessionKilledError();
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

  emitObserverEvent(event: AgentEvent): void {
    this.#activeRun?.emit(event);
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
    closeRuntimeInput(this.#activeRuntimeInput, killedError.message);
    const runToClose = this.#runToCloseOnKill ?? this.#activeRun;
    runToClose?.emit({
      type: "turn-error",
      message: killedError.message,
    });
    runToClose?.close(undefined, killedError.message);

    while (this.#inputQueue.length > 0) {
      const item = this.#inputQueue.shift();
      closeRuntimeInput(item?.runtimeInput, killedError.message);
      item?.run.emit({
        type: "turn-error",
        message: killedError.message,
      });
      item?.run.close(undefined, killedError.message);
    }
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
      await withSteeringPlacement(runtimeInput, "turn-start", async () => {
        await this.#hooks?.beforeTurn?.({
          history: this.#state.modelSnapshot(),
          input,
          signal: activeAbort.signal,
        });
      });
      await withRuntimeInputWindow(runtimeInput, "turn-start", async () => {
        await run.emitBoundary({ type: "turn-start" });
      });
      this.#state.appendUserInput(input);
      await this.#state.commit();
      await this.#drainRuntimeInput(run, runtimeInput, "turn-start");

      const result = await runAgentLoop({
        emit: async (event) => {
          if (event.type === "step-start" || event.type === "step-end") {
            await withRuntimeInputWindow(runtimeInput, event.type, async () => {
              await run.emitBoundary(event);
            });
            const runtimeInputAdded = await this.#drainRuntimeInput(
              run,
              runtimeInput,
              event.type
            );

            if (event.type === "step-end") {
              return { runtimeInputAdded };
            }
            return;
          }

          run.emit(event);
        },
        history: this.#state.history,
        hooks: hooksForRuntimeInput(this.#hooks, runtimeInput),
        llm: this.#llm,
        signal: activeAbort.signal,
      });

      await this.#state.commit();
      const terminalEvent = result === "aborted" ? "turn-abort" : "turn-end";
      closeRuntimeInput(runtimeInput, terminalEvent);
      this.#activeRuntimeInput = undefined;
      this.#activeRun = undefined;
      await runAfterTurnHook(this.#hooks, {
        history: this.#state.modelSnapshot(),
        input,
        result,
        signal: activeAbort.signal,
      });
      run.emit({ type: terminalEvent });
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

  async #drainRuntimeInput(
    run: BufferedAgentRun,
    runtimeInput: RuntimeInputState,
    placement: RuntimeInputPlacement
  ): Promise<boolean> {
    let added = false;
    let next = shiftRuntimeInput(runtimeInput, placement);
    while (next) {
      added = true;
      run.emit({ type: "runtime-input", input: next.input, placement });
      this.#state.appendUserInput(next.input);
      await this.#state.commit();
      next = shiftRuntimeInput(runtimeInput, placement);
    }

    return added;
  }
}
