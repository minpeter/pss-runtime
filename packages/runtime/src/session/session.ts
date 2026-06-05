import type { ModelMessage } from "ai";
import { runAgentLoop } from "../agent-loop";
import type { Llm, LlmOutput } from "../llm";
import type { ResolvedAgentPlugins } from "../plugins/runner";
import { wrapLlmWithContextTransforms } from "../plugins/runner";
import type { AgentPluginScope } from "../plugins/scope";
import type { UserInput } from "./events";
import { ModelMessageHistory } from "./history";
import type { AgentInput } from "./input";
import {
  type AgentSessionLifecycle,
  createRuntimeInputStepLifecycle,
  runPluginAfterTurnHandlers,
  runPluginBeforeTurnHandlers,
} from "./lifecycle";
import type { AgentRun } from "./run";
import { BufferedAgentRun } from "./run";
import {
  addRuntimeInput,
  closeRuntimeInput,
  createRuntimeInputState,
  normalizeAgentInput,
  type RuntimeInputPlacement,
  type RuntimeInputState,
  shiftRuntimeInput,
} from "./runtime-input";
import {
  type AgentCompactionOverlay,
  decodeStoredSessionSnapshot,
  encodeSessionSnapshot,
} from "./snapshot";
import type { SessionStore } from "./store/types";

export type { AgentInput, SessionInput, UserInput } from "./input";
export type { AgentRun } from "./run";

interface SessionPersistenceOptions {
  readonly key: string;
  readonly store: SessionStore;
}

interface QueuedInput {
  readonly input: UserInput;
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
}

const noBoundaryDecision = undefined;

export class AgentSession {
  readonly #inputQueue: QueuedInput[] = [];
  readonly #internalLlm: Llm;
  readonly #llm: Llm;
  readonly #persistence: SessionPersistenceOptions;
  readonly #plugins?: ResolvedAgentPlugins;
  #activeAbort?: AbortController;
  #activeRun?: BufferedAgentRun;
  #activeRuntimeInput?: RuntimeInputState;
  #history = new ModelMessageHistory();
  #killed = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #pluginState: Record<string, unknown> = {};
  #compactions: AgentCompactionOverlay[] = [];
  #running = false;
  #storeVersion: string | undefined;

  constructor(
    llm: Llm,
    persistence: SessionPersistenceOptions,
    plugins?: ResolvedAgentPlugins,
    internalLlm: Llm = llm
  ) {
    this.#internalLlm = internalLlm;
    this.#persistence = persistence;
    this.#plugins = plugins;
    this.#llm = wrapLlmWithContextTransforms({
      createScope: (signal) => this.#createPluginScope(signal),
      llm,
      sessionKey: persistence.key,
      transforms: plugins?.contextTransforms ?? [],
    });
  }

  async send(input: AgentInput): Promise<AgentRun> {
    if (this.#killed) {
      throw sessionKilledError();
    }

    await this.#ensureLoaded();

    if (this.#killed) {
      throw sessionKilledError();
    }

    const runtimeInput = createRuntimeInputState();
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

    await addRuntimeInput(runtimeInput, input);
    return run;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  kill(): void {
    if (this.#killed) {
      return;
    }

    this.#killed = true;
    this.#activeAbort?.abort();
    closeRuntimeInput(this.#activeRuntimeInput, sessionKilledError().message);

    while (this.#inputQueue.length > 0) {
      const item = this.#inputQueue.shift();
      closeRuntimeInput(item?.runtimeInput, sessionKilledError().message);
      item?.run.emit({
        type: "turn-error",
        message: sessionKilledError().message,
      });
      item?.run.close(undefined, sessionKilledError().message);
    }
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    this.#loadPromise ??= this.#loadSessionState();
    try {
      await this.#loadPromise;
    } catch (error) {
      this.#loadPromise = undefined;
      throw error;
    }
  }

  async #loadSessionState(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    await this.#replaceWithStoredSession();
    this.#loaded = true;
  }

  async #replaceWithStoredSession(): Promise<void> {
    const stored = await this.#persistence.store.load(this.#persistence.key);
    this.#storeVersion = stored?.version;
    const snapshot = decodeStoredSessionSnapshot(stored);
    this.#history = new ModelMessageHistory(snapshot.history);
    this.#pluginState = structuredClone(snapshot.pluginState);
    this.#compactions = structuredClone(snapshot.compactions);
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
    const historySnapshot = this.#history.modelSnapshot();

    try {
      await this.#withSteeringPlacement(
        runtimeInput,
        "turn-start",
        async () => {
          await runPluginBeforeTurnHandlers(this.#pluginLifecycle(), {
            input,
            runtimeInput,
            signal: activeAbort.signal,
          });
        }
      );
      await this.#withRuntimeInputWindow(
        runtimeInput,
        "turn-start",
        async () => {
          await run.emitBoundary({ type: "turn-start" });
        }
      );
      this.#history.appendUserInput(input);
      await this.#commitHistory();
      await this.#drainRuntimeInput(run, runtimeInput, "turn-start");

      const result = await runAgentLoop({
        emit: async (event) => {
          if (event.type === "step-start" || event.type === "step-end") {
            await this.#withRuntimeInputWindow(
              runtimeInput,
              event.type,
              async () => {
                await run.emitBoundary(event);
              }
            );
            const runtimeInputAdded = await this.#drainRuntimeInput(
              run,
              runtimeInput,
              event.type
            );

            if (event.type === "step-end") {
              return { runtimeInputAdded };
            }
            return noBoundaryDecision;
          }

          run.emit(event);
        },
        history: this.#history,
        stepLifecycle: createRuntimeInputStepLifecycle({
          lifecycle: this.#pluginLifecycle(),
          runtimeInput,
          withSteeringPlacement: (placement, callback) =>
            this.#withSteeringPlacement(runtimeInput, placement, callback),
        }),
        llm: this.#llm,
        signal: activeAbort.signal,
      });

      await this.#commitHistory();
      const terminalEvent = result === "aborted" ? "turn-abort" : "turn-end";
      closeRuntimeInput(runtimeInput, terminalEvent);
      this.#activeRuntimeInput = undefined;
      this.#activeRun = undefined;
      const pluginHandlersRan = await runPluginAfterTurnHandlers(
        this.#pluginLifecycle(),
        {
          input,
          result,
          signal: activeAbort.signal,
        }
      );
      if (pluginHandlersRan) {
        await this.#commitHistory();
      }
      run.emit({ type: terminalEvent });
    } catch (error) {
      if (error instanceof SessionCommitConflictError) {
        run.emit({ type: "turn-error", message: error.message });
        closeRuntimeInput(runtimeInput, "a session commit conflict");
        this.#activeAbort = undefined;
        return;
      }

      this.#history.rollback(historySnapshot);
      try {
        await this.#commitHistory();
      } catch (rollbackError) {
        run.emit({
          type: "turn-error",
          message: `${errorMessage(error)}; history rollback persistence failed: ${errorMessage(
            rollbackError
          )}`,
        });
        closeRuntimeInput(runtimeInput, "turn-error");
        this.#activeAbort = undefined;
        return;
      }
      run.emit({ type: "turn-error", message: errorMessage(error) });
      closeRuntimeInput(runtimeInput, "turn-error");
    } finally {
      closeRuntimeInput(runtimeInput);
      this.#activeAbort = undefined;
      this.#activeRun = undefined;
      this.#activeRuntimeInput = undefined;
      run.close(undefined, runtimeInput.closedReason);
    }
  }

  async #commitHistory(): Promise<void> {
    const result = await this.#persistence.store.commit(
      this.#persistence.key,
      {
        state: encodeSessionSnapshot({
          compactions: this.#compactions,
          history: this.#history.modelSnapshot(),
          pluginState: this.#pluginState,
        }),
      },
      { expectedVersion: this.#storeVersion ?? null }
    );

    if (!result.ok) {
      await this.#replaceWithStoredSession();
      throw new SessionCommitConflictError(this.#persistence.key);
    }

    this.#storeVersion = result.version;
  }

  #createPluginScope(signal: AbortSignal): AgentPluginScope {
    return {
      eventHandlers: this.#plugins?.eventHandlers,
      getCompactions: () => structuredClone(this.#compactions),
      getPluginState: (pluginName) => this.#pluginState[pluginName],
      history: () => this.#history.modelSnapshot(),
      sessionKey: this.#persistence.key,
      setCompactions: (compactions) => {
        this.#compactions = structuredClone([...compactions]);
      },
      setPluginState: (pluginName, state) => {
        this.#pluginState = {
          ...this.#pluginState,
          [pluginName]: structuredClone(state),
        };
      },
      signal,
      steer: (input) => this.steer(input),
      summarize: (messages) => this.#summarizeForPlugins(messages, signal),
    };
  }

  #pluginLifecycle(): AgentSessionLifecycle {
    return {
      createScope: (signal) => this.#createPluginScope(signal),
      history: () => this.#history.modelSnapshot(),
      plugins: this.#plugins,
      sessionKey: this.#persistence.key,
      steerCurrentRun: async (runtimeInput, input) => {
        await addRuntimeInput(runtimeInput, input);
        if (!this.#activeRun) {
          throw new Error("Agent plugin steering requires an active run.");
        }
        return this.#activeRun;
      },
      steerSession: (input) => this.steer(input),
    };
  }

  async #summarizeForPlugins(
    messages: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<string> {
    const output = await this.#internalLlm({
      history: [
        {
          content:
            "Summarize these earlier session messages for future model context.",
          role: "system",
        },
        ...messages,
      ],
      signal,
    });
    return outputToText(output) || `Summarized ${messages.length} messages.`;
  }

  async #withRuntimeInputWindow<T>(
    runtimeInput: RuntimeInputState,
    placement: RuntimeInputPlacement,
    callback: () => Promise<T>
  ): Promise<T> {
    const previousSteerPlacement = runtimeInput.steerPlacement;
    runtimeInput.placement = placement;
    runtimeInput.steerPlacement = placement;
    try {
      return await callback();
    } finally {
      runtimeInput.placement = undefined;
      runtimeInput.steerPlacement = previousSteerPlacement;
    }
  }

  async #withSteeringPlacement<T>(
    runtimeInput: RuntimeInputState,
    placement: RuntimeInputPlacement,
    callback: () => Promise<T>
  ): Promise<T> {
    const previousSteerPlacement = runtimeInput.steerPlacement;
    runtimeInput.steerPlacement = placement;
    try {
      return await callback();
    } finally {
      runtimeInput.steerPlacement = previousSteerPlacement;
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
      this.#history.appendUserInput(next.input);
      await this.#commitHistory();
      next = shiftRuntimeInput(runtimeInput, placement);
    }

    return added;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function outputToText(output: LlmOutput): string {
  const parts: string[] = [];
  for (const message of output) {
    if (message.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        parts.push(part.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function sessionKilledError(): Error {
  return new Error("Session killed");
}

class SessionCommitConflictError extends Error {
  constructor(key: string) {
    super(`Session ${JSON.stringify(key)} commit conflict`);
  }
}
