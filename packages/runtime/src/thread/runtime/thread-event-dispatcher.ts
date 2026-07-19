import type { ModelMessage } from "ai";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
import type { PluginRuntime } from "../../plugins/plugin-runtime";
import type {
  HostAttachmentStore,
  RuntimeAttachmentReference,
} from "../input/attachments";
import type { AgentEvent, ModelUsage, ToolResult } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";
import type { ThreadCompactionInput, ThreadState } from "../state/thread-state";
import {
  beforeToolCallEvent,
  interceptAgentEvent,
} from "./event-interception";

interface ThreadEventDispatcherOptions {
  readonly attachmentStore?: HostAttachmentStore;
  readonly history: () => readonly ModelMessage[];
  readonly pluginRuntime?: PluginRuntime;
  readonly signal: () => AbortSignal | undefined;
  readonly threadKey: string;
}

interface InterceptEventOptions {
  readonly stagedRefs?: RuntimeAttachmentReference[];
}

export class ThreadEventDispatcher {
  readonly #attachmentStore: HostAttachmentStore | undefined;
  readonly #history: () => readonly ModelMessage[];
  #observerEventBuffer?: AgentEvent[];
  readonly #pluginRuntime: PluginRuntime | undefined;
  readonly #signal: () => AbortSignal | undefined;
  readonly #threadKey: string;

  constructor(options: ThreadEventDispatcherOptions) {
    this.#attachmentStore = options.attachmentStore;
    this.#history = options.history;
    this.#pluginRuntime = options.pluginRuntime;
    this.#signal = options.signal;
    this.#threadKey = options.threadKey;
  }

  async captureObserverEvents<T>(
    run: BufferedAgentTurn,
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
    activeRun: BufferedAgentTurn | undefined,
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

    return this.emitRunEvent(activeRun, event).then(() => undefined);
  }

  async emitRunBoundaryEvent(
    run: BufferedAgentTurn,
    event: AgentEvent,
    options: { readonly awaitAck?: boolean } = {}
  ): Promise<void> {
    const processed =
      event.type === "turn-start" && this.#pluginRuntime
        ? await this.#pluginRuntime.beforeTurnStart(
            this.#threadKey,
            event,
            this.#history(),
            this.#activeSignal()
          )
        : event;
    await this.observeRunEvent(processed);
    if (options.awaitAck === false) {
      run.emit(processed);
      return;
    }

    await run.emitBoundary(processed);
  }

  async observeRunEvent(event: AgentEvent): Promise<void> {
    await this.#pluginRuntime?.observeAgentEvent(
      this.#threadKey,
      event,
      this.#history(),
      this.#activeSignal()
    );
  }

  async emitRunEvent(
    run: BufferedAgentTurn,
    event: AgentEvent
  ): Promise<AgentEvent | "handled"> {
    const processed = await this.interceptEvent(event);
    if (processed === "handled") {
      return "handled";
    }

    run.emit(processed);
    return processed;
  }

  async emitModelUsageEvent(
    run: BufferedAgentTurn,
    event: ModelUsage,
    persistEvent?: (event: AgentEvent) => Promise<void> | void
  ): Promise<ModelUsage> {
    try {
      await persistEvent?.(event);
    } finally {
      run.emit(event);
    }
    await this.observeRunEvent(event);
    return event;
  }

  async interceptBeforeToolCall(
    checkpoint: RuntimeToolExecutionCheckpoint
  ): Promise<RuntimeToolExecutionDecision> {
    const event = beforeToolCallEvent(checkpoint);
    return await this.#pluginRuntime?.beforeToolExecution(
      this.#threadKey,
      event,
      this.#history(),
      this.#activeSignal()
    );
  }

  async interceptAfterToolCall(
    checkpoint: RuntimeToolExecutionCheckpoint & { readonly output: unknown }
  ): Promise<RuntimeToolExecutionResult | undefined> {
    if (!this.#pluginRuntime) {
      return;
    }
    const event: ToolResult = {
      output: checkpoint.output,
      toolCallId: checkpoint.toolCallId,
      toolName: checkpoint.toolName,
      type: "tool-result",
    };
    const transformed = await this.#pluginRuntime.afterToolExecution(
      this.#threadKey,
      event,
      this.#history(),
      this.#activeSignal()
    );
    return { output: transformed.output };
  }

  async compact(
    state: ThreadState,
    input: ThreadCompactionInput
  ): Promise<boolean> {
    const decision = this.#pluginRuntime
      ? await this.#pluginRuntime.beforeCompact(
          this.#threadKey,
          input,
          this.#history(),
          this.#activeSignal()
        )
      : { cancelled: false, input };
    if (decision.cancelled) {
      return false;
    }

    await state.compact(decision.input);
    await this.#pluginRuntime?.notifyCompacted(
      this.#threadKey,
      decision.input,
      this.#history(),
      this.#activeSignal()
    );
    return true;
  }

  startThread(): Promise<void> {
    return (
      this.#pluginRuntime?.startThread(
        this.#threadKey,
        this.#history(),
        new AbortController().signal
      ) ?? Promise.resolve()
    );
  }

  shutdownThread(): Promise<void> {
    return (
      this.#pluginRuntime?.shutdownThread(
        this.#threadKey,
        this.#history(),
        new AbortController().signal
      ) ?? Promise.resolve()
    );
  }

  async interceptEvent(
    event: AgentEvent,
    options: InterceptEventOptions = {}
  ): Promise<AgentEvent | "handled"> {
    return await interceptAgentEvent(event, {
      attachmentStore: this.#attachmentStore,
      history: this.#history,
      pluginRuntime: this.#pluginRuntime,
      signal: () => this.#activeSignal(),
      stagedRefs: options.stagedRefs,
      threadKey: this.#threadKey,
    });
  }

  emitProcessedEvent(run: BufferedAgentTurn, event: AgentEvent): void {
    run.emit(event);
  }

  #activeSignal(): AbortSignal {
    return this.#signal() ?? new AbortController().signal;
  }
}
