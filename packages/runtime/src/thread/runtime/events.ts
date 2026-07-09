import type { ModelMessage } from "ai";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionDecision,
} from "../../llm/llm";
import {
  type HostAttachmentStore,
  type RuntimeAttachmentReference,
  stageAgentEventAttachments,
} from "../input/attachments";
import {
  type AgentPlugin,
  type PluginPipelineResult,
  runPluginsForEvent,
} from "../plugins/pipeline";
import type { AgentEvent, BeforeToolCall } from "../protocol/events";
import type { BufferedAgentTurn } from "../protocol/turn";

interface ThreadEventDispatcherOptions {
  readonly attachmentStore?: HostAttachmentStore;
  readonly history: () => readonly ModelMessage[];
  readonly plugins: readonly AgentPlugin[];
  readonly signal: () => AbortSignal | undefined;
}

interface InterceptEventOptions {
  readonly stagedRefs?: RuntimeAttachmentReference[];
}

export class ThreadEventDispatcher {
  readonly #attachmentStore: HostAttachmentStore | undefined;
  readonly #history: () => readonly ModelMessage[];
  #observerEventBuffer?: AgentEvent[];
  readonly #plugins: readonly AgentPlugin[];
  readonly #signal: () => AbortSignal | undefined;

  constructor(options: ThreadEventDispatcherOptions) {
    this.#attachmentStore = options.attachmentStore;
    this.#history = options.history;
    this.#plugins = options.plugins;
    this.#signal = options.signal;
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
    await this.observeRunEvent(event);
    if (options.awaitAck === false) {
      run.emit(event);
      return;
    }

    await run.emitBoundary(event);
  }

  async observeRunEvent(event: AgentEvent): Promise<void> {
    await runPluginsForEvent(
      this.#plugins,
      {
        event,
        history: this.#history(),
        signal: this.#signal(),
      },
      { observeOnly: true }
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

  async interceptBeforeToolCall(
    checkpoint: RuntimeToolExecutionCheckpoint
  ): Promise<RuntimeToolExecutionDecision> {
    const pipeline = await this.#runInterceptPipeline(
      beforeToolCallEvent(checkpoint)
    );

    return pipeline.kind === "needs-recovery"
      ? { status: "needs-recovery" }
      : undefined;
  }

  async interceptEvent(
    event: AgentEvent,
    options: InterceptEventOptions = {}
  ): Promise<AgentEvent | "handled"> {
    const pipeline = await this.#runInterceptPipeline(event);
    if (pipeline.kind === "handled") {
      return "handled";
    }

    if (pipeline.kind === "needs-recovery") {
      return event;
    }

    return stageAgentEventAttachments(pipeline.event, this.#attachmentStore, {
      stagedRefs: options.stagedRefs,
      trustRuntimeAttachmentRefs: true,
    });
  }

  emitProcessedEvent(run: BufferedAgentTurn, event: AgentEvent): void {
    run.emit(event);
  }

  #runInterceptPipeline(event: AgentEvent): Promise<PluginPipelineResult> {
    return runPluginsForEvent(this.#plugins, {
      event,
      history: this.#history(),
      signal: this.#signal(),
    });
  }
}

function beforeToolCallEvent(
  checkpoint: RuntimeToolExecutionCheckpoint
): BeforeToolCall {
  return {
    attempt: checkpoint.attempt,
    idempotencyKey: checkpoint.idempotencyKey,
    input: checkpoint.input,
    policy: checkpoint.policy,
    toolCallId: checkpoint.toolCallId,
    toolName: checkpoint.toolName,
    type: "before-tool-call",
  };
}
