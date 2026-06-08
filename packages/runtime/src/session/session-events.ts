import type { RuntimeLlmContext } from "../llm";
import { type AgentPlugin, runEventPlugins } from "../plugins";
import type { AgentEvent } from "./events";
import type { BufferedAgentRun } from "./run";

interface SessionEventDispatcherOptions {
  readonly history: () => RuntimeLlmContext["history"];
  readonly plugins: readonly AgentPlugin[];
  readonly signal: () => AbortSignal | undefined;
}

export class SessionEventDispatcher {
  readonly #history: () => RuntimeLlmContext["history"];
  #observerEventBuffer?: AgentEvent[];
  readonly #plugins: readonly AgentPlugin[];
  readonly #signal: () => AbortSignal | undefined;

  constructor(options: SessionEventDispatcherOptions) {
    this.#history = options.history;
    this.#plugins = options.plugins;
    this.#signal = options.signal;
  }

  async captureObserverEvents<T>(
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
        await this.emitRunEvent(run, event);
      }
      this.#observerEventBuffer = previousBuffer;
      throw error;
    }
  }

  emitObserverEvent(
    activeRun: BufferedAgentRun | undefined,
    event: AgentEvent
  ): Promise<void> {
    const observerEventBuffer = this.#observerEventBuffer;
    if (observerEventBuffer) {
      observerEventBuffer.push(structuredClone(event));
      return Promise.resolve();
    }

    if (!activeRun) {
      return Promise.resolve();
    }

    return this.emitRunEvent(activeRun, event);
  }

  async emitRunBoundaryEvent(
    run: BufferedAgentRun,
    event: AgentEvent
  ): Promise<void> {
    await this.#runPlugins(event);
    await run.emitBoundary(event);
  }

  async emitRunEvent(run: BufferedAgentRun, event: AgentEvent): Promise<void> {
    await this.#runPlugins(event);
    run.emit(event);
  }

  #runPlugins(event: AgentEvent): Promise<void> {
    return runEventPlugins(this.#plugins, {
      event,
      history: this.#history(),
      signal: this.#signal(),
    });
  }
}
