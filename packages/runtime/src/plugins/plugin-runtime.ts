import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { ModelStepOutput } from "../llm/model-step-types";
import type { AgentEvent, ToolResult } from "../thread/protocol/events";
import type { ThreadContextMessage } from "../thread/state/context";
import type { ThreadCompactionInput } from "../thread/state/thread-state";
import type {
  InputAcceptEvent,
  PluginDefinition,
  PluginToolCallBeforeEvent,
} from "./api";
import type { RuntimeDiagnosticsSink } from "./diagnostics";
import {
  afterToolExecution,
  beforeToolExecution,
  beforeTurnStart,
  interceptInput,
} from "./plugin-input-hooks";
import {
  clearThreadState,
  createRuntimeState,
  disposeRuntime,
  loadPlugin,
} from "./plugin-lifecycle";
import {
  beforeCompact,
  transformModelContext,
  transformModelStep,
} from "./plugin-model-transforms";
import {
  notifyCompacted,
  observeAgentEvent,
  shutdownThread,
  startThread,
} from "./plugin-notifications";
import { wrapRuntimeModel } from "./plugin-tool-provider";
import type {
  PluginCompactionDecision,
  PluginInputDecision,
  PluginRuntimeOptions,
  PluginRuntimeState,
  PluginToolExecutionDecision,
} from "./plugin-types";

async function reportPluginFailure(
  diagnostics: RuntimeDiagnosticsSink,
  pluginIndex: number,
  phase: "factory" | "handler",
  cause: unknown,
  event?: string
): Promise<void> {
  try {
    await diagnostics.report({
      cause,
      code: `plugin.${phase}_failed`,
      ...(event ? { event } : {}),
      level: "error",
      phase,
      pluginIndex,
    });
  } catch {
    return;
  }
}

export class PluginRuntime {
  readonly #state: PluginRuntimeState;

  private constructor(options: PluginRuntimeOptions) {
    this.#state = createRuntimeState(
      options,
      (pluginIndex, phase, cause, event) =>
        reportPluginFailure(
          options.diagnostics,
          pluginIndex,
          phase,
          cause,
          event
        )
    );
  }

  static async create(
    definitions: readonly PluginDefinition[],
    options: PluginRuntimeOptions
  ): Promise<PluginRuntime> {
    const runtime = new PluginRuntime(options);
    try {
      for (const [index, plugin] of definitions.entries()) {
        await loadPlugin(
          runtime.#state,
          plugin,
          index,
          options.factoryTimeoutMs
        );
      }
    } catch (cause) {
      await runtime.dispose();
      throw cause;
    }
    return runtime;
  }

  get tools(): ToolSet {
    return this.#state.tools;
  }

  interceptInput(
    threadKey: string,
    event: InputAcceptEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<PluginInputDecision> {
    return interceptInput(this.#state, threadKey, event, history, signal);
  }

  beforeTurnStart(
    threadKey: string,
    event: Extract<AgentEvent, { type: "turn-start" }>,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<Extract<AgentEvent, { type: "turn-start" }>> {
    return beforeTurnStart(this.#state, threadKey, event, history, signal);
  }

  beforeToolExecution(
    threadKey: string,
    event: PluginToolCallBeforeEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<PluginToolExecutionDecision> {
    return beforeToolExecution(this.#state, threadKey, event, history, signal);
  }

  afterToolExecution(
    threadKey: string,
    event: ToolResult,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<ToolResult> {
    return afterToolExecution(this.#state, threadKey, event, history, signal);
  }

  beforeCompact(
    threadKey: string,
    input: ThreadCompactionInput,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<PluginCompactionDecision> {
    return beforeCompact(this.#state, threadKey, input, history, signal);
  }

  notifyCompacted(
    threadKey: string,
    input: ThreadCompactionInput,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<void> {
    return notifyCompacted(this.#state, threadKey, input, history, signal);
  }

  startThread(
    threadKey: string,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<void> {
    return startThread(this.#state, threadKey, history, signal);
  }

  shutdownThread(
    threadKey: string,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<void> {
    return shutdownThread(this.#state, threadKey, history, signal);
  }

  observeAgentEvent(
    threadKey: string,
    event: AgentEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<void> {
    return observeAgentEvent(this.#state, threadKey, event, history, signal);
  }

  transformModelContext(
    threadKey: string,
    messages: readonly ThreadContextMessage[],
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<ThreadContextMessage[]> {
    return transformModelContext(
      this.#state,
      threadKey,
      messages,
      history,
      signal
    );
  }

  transformModelStep(
    threadKey: string,
    messages: readonly ModelStepOutput[number][],
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#state.abort.signal
  ): Promise<ModelStepOutput> {
    return transformModelStep(
      this.#state,
      threadKey,
      messages,
      history,
      signal
    );
  }

  wrapModel(
    model: LanguageModel,
    threadKey: string
  ): Exclude<LanguageModel, string> {
    return wrapRuntimeModel(this.#state, model, threadKey);
  }

  clearThread(threadKey: string): void {
    clearThreadState(this.#state, threadKey);
  }

  dispose(): Promise<void> {
    return disposeRuntime(this.#state);
  }
}
