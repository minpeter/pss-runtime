import {
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import type { ModelStepOutput } from "../llm/llm";
import type { AgentEvent, ToolResult } from "../thread/protocol/events";
import type { ThreadCompactionInput } from "../thread/state/thread-state";
import type {
  InputAcceptEvent,
  PluginAPI,
  PluginCapability,
  PluginDefinition,
  PluginEventContext,
  PluginEventMap,
  PluginHandler,
  PluginRequestResultMap,
  PluginToolCallBeforeEvent,
  ProviderCallOptions,
  Subscription,
  ThreadScopeCapability,
  ThreadStateHandle,
} from "./api";
import type { RuntimeDiagnosticsSink } from "./diagnostics";

interface RegisteredHandler {
  active: boolean;
  readonly event: keyof PluginEventMap;
  readonly handler: PluginHandler<keyof PluginEventMap>;
}

interface PluginRegistration {
  readonly handlers: RegisteredHandler[];
  readonly index: number;
  state: "active" | "disposed" | "loading";
  readonly subscriptions: Subscription[];
  readonly tools: Map<string, PluginCapability & { readonly kind: "tool" }>;
}

interface PluginInvocationContext {
  readonly history: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly threadKey: string;
}

export interface PluginRuntimeOptions {
  readonly diagnostics: RuntimeDiagnosticsSink;
  readonly factoryTimeoutMs: number;
  readonly hookTimeoutMs: number;
  readonly tools?: ToolSet;
}

export type PluginInputDecision = InputAcceptEvent | "handled";

export type PluginToolExecutionDecision =
  | { readonly status: "blocked"; readonly output: unknown }
  | { readonly status: "needs-recovery" }
  | undefined;

export interface PluginCompactionDecision {
  readonly cancelled: boolean;
  readonly input: ThreadCompactionInput;
}

export class PluginInitializationError extends Error {
  readonly cause: unknown;
  readonly pluginIndex: number;
  constructor(pluginIndex: number, cause: unknown) {
    super(`Plugin at index ${pluginIndex} failed to initialize.`);
    this.name = "PluginInitializationError";
    this.pluginIndex = pluginIndex;
    this.cause = cause;
  }
}

export class PluginHookError extends Error {
  readonly cause: unknown;
  readonly event: string;
  readonly pluginIndex: number;
  constructor(pluginIndex: number, event: string, cause: unknown) {
    super(`Plugin at index ${pluginIndex} failed handling ${event}.`);
    this.name = "PluginHookError";
    this.pluginIndex = pluginIndex;
    this.event = event;
    this.cause = cause;
  }
}

export class PluginRegistrationClosedError extends Error {
  readonly pluginIndex: number;
  constructor(pluginIndex: number) {
    super(
      `Plugin at index ${pluginIndex} attempted to register after its factory completed.`
    );
    this.name = "PluginRegistrationClosedError";
    this.pluginIndex = pluginIndex;
  }
}

export class PluginRuntime {
  readonly #abort = new AbortController();
  readonly #diagnostics: RuntimeDiagnosticsSink;
  readonly #hookTimeoutMs: number;
  readonly #registrations: PluginRegistration[] = [];
  readonly #threadStateClearers = new Set<(key: string) => void>();
  readonly #tools: ToolSet;

  private constructor(options: PluginRuntimeOptions) {
    this.#diagnostics = options.diagnostics;
    this.#hookTimeoutMs = options.hookTimeoutMs;
    this.#tools = { ...(options.tools ?? {}) };
  }

  static async create(
    definitions: readonly PluginDefinition[],
    options: PluginRuntimeOptions
  ): Promise<PluginRuntime> {
    const runtime = new PluginRuntime(options);
    try {
      for (const [index, plugin] of definitions.entries()) {
        await runtime.#load(plugin, index, options.factoryTimeoutMs);
      }
    } catch (cause) {
      await runtime.dispose();
      throw cause;
    }
    return runtime;
  }

  get tools(): ToolSet {
    return this.#tools;
  }

  async interceptInput(
    threadKey: string,
    event: InputAcceptEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<PluginInputDecision> {
    let current = structuredClone(event);
    for (const { registered, registration } of this.#handlers("input.accept")) {
      const result = await this.#invoke(
        registration,
        "input.accept",
        registered,
        structuredClone(current),
        { history, signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["input.accept"]
        | undefined;
      await this.#validateRequestResult(
        registration,
        "input.accept",
        decision,
        ["continue", "handled", "transform"]
      );
      if (decision?.action === "handled") {
        return "handled";
      }
      if (decision?.action === "transform") {
        try {
          assertInputAcceptEvent(decision.value);
        } catch (cause) {
          await this.#throwHookFailure(registration, "input.accept", cause);
        }
        current = structuredClone(decision.value);
      }
    }
    return current;
  }

  async beforeTurnStart(
    threadKey: string,
    event: Extract<AgentEvent, { type: "turn-start" }>,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<Extract<AgentEvent, { type: "turn-start" }>> {
    let current = structuredClone(event);
    for (const { registered, registration } of this.#handlers(
      "turn.start.before"
    )) {
      const result = await this.#invoke(
        registration,
        "turn.start.before",
        registered,
        structuredClone(current),
        { history, signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["turn.start.before"]
        | undefined;
      await this.#validateRequestResult(
        registration,
        "turn.start.before",
        decision,
        ["continue", "transform"]
      );
      if (decision?.action === "transform") {
        try {
          assertTurnStartEvent(decision.value);
        } catch (cause) {
          await this.#throwHookFailure(
            registration,
            "turn.start.before",
            cause
          );
        }
        current = structuredClone(decision.value);
      }
    }
    return current;
  }

  async beforeToolExecution(
    threadKey: string,
    event: PluginToolCallBeforeEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<PluginToolExecutionDecision> {
    for (const { registered, registration } of this.#handlers(
      "tool.call.before"
    )) {
      const result = await this.#invoke(
        registration,
        "tool.call.before",
        registered,
        structuredClone(event),
        { history, signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["tool.call.before"]
        | undefined;
      await this.#validateRequestResult(
        registration,
        "tool.call.before",
        decision,
        ["block", "continue", "needs-recovery"]
      );
      if (decision?.action === "needs-recovery") {
        return { status: "needs-recovery" };
      }
      if (decision?.action === "block") {
        return {
          output: {
            blocked: true,
            reason: decision.reason ?? "Tool call blocked by plugin.",
          },
          status: "blocked",
        };
      }
    }

    await this.#notify("tool.execution.start", event, {
      history,
      signal,
      threadKey,
    });
    return;
  }

  async afterToolExecution(
    threadKey: string,
    event: ToolResult,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<ToolResult> {
    let current = structuredClone(event);
    for (const { registered, registration } of this.#handlers("tool.result")) {
      const result = await this.#invoke(
        registration,
        "tool.result",
        registered,
        structuredClone(current),
        { history, signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["tool.result"]
        | undefined;
      await this.#validateRequestResult(registration, "tool.result", decision, [
        "continue",
        "transform",
      ]);
      if (decision?.action === "transform") {
        try {
          assertToolResultEvent(decision.value);
        } catch (cause) {
          await this.#throwHookFailure(registration, "tool.result", cause);
        }
        current = structuredClone(decision.value);
      }
    }

    await this.#notify("tool.execution.end", current, {
      history,
      signal,
      threadKey,
    });
    return current;
  }

  async beforeCompact(
    threadKey: string,
    input: ThreadCompactionInput,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<PluginCompactionDecision> {
    let current = structuredClone(input);
    for (const { registered, registration } of this.#handlers(
      "thread.compaction.before"
    )) {
      const result = await this.#invoke(
        registration,
        "thread.compaction.before",
        registered,
        { input: structuredClone(current) },
        { history, signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["thread.compaction.before"]
        | undefined;
      await this.#validateRequestResult(
        registration,
        "thread.compaction.before",
        decision,
        ["cancel", "continue", "transform"]
      );
      if (decision?.action === "cancel") {
        return { cancelled: true, input: current };
      }
      if (decision?.action === "transform") {
        try {
          assertCompactionInput(decision.value.input);
        } catch (cause) {
          await this.#throwHookFailure(
            registration,
            "thread.compaction.before",
            cause
          );
        }
        current = structuredClone(decision.value.input);
      }
    }
    return { cancelled: false, input: current };
  }

  notifyCompacted(
    threadKey: string,
    input: ThreadCompactionInput,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<void> {
    return this.#notify(
      "thread.compaction.after",
      { input: structuredClone(input) },
      { history, signal, threadKey }
    );
  }

  startThread(
    threadKey: string,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<void> {
    return this.#notify("thread.start", {}, { history, signal, threadKey });
  }

  shutdownThread(
    threadKey: string,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<void> {
    return this.#notify("thread.shutdown", {}, { history, signal, threadKey });
  }

  async observeAgentEvent(
    threadKey: string,
    event: AgentEvent,
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<void> {
    const context = { history, signal, threadKey };
    switch (event.type) {
      case "assistant-output":
      case "assistant-reasoning":
        await this.#notify("message.start", event, context);
        await this.#notify("message.update", event, context);
        await this.#notify("message.end", event, context);
        return;
      case "step-start":
        await this.#notify("step.start", event, context);
        return;
      case "step-end":
        await this.#notify("step.end", event, context);
        return;
      case "model-usage":
        await this.#notify("model.usage", event, context);
        return;
      case "turn-start":
        await this.#notify("turn.start", event, context);
        return;
      case "turn-end":
        await this.#notify("turn.end", event, context);
        await this.#notify("turn.settled", event, context);
        return;
      case "turn-abort":
        await this.#notify("turn.abort", event, context);
        await this.#notify("turn.settled", event, context);
        return;
      case "turn-error":
        await this.#notify("turn.error", event, context);
        await this.#notify("turn.settled", event, context);
        return;
      default:
        return;
    }
  }

  async transformModelContext(
    threadKey: string,
    messages: readonly ModelMessage[],
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<ModelMessage[]> {
    let current = structuredClone([...messages]);
    for (const { registered, registration } of this.#handlers(
      "model.context"
    )) {
      const result = await this.#invoke(
        registration,
        "model.context",
        registered,
        { messages: structuredClone(current) },
        { history, signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["model.context"]
        | undefined;
      await this.#validateRequestResult(
        registration,
        "model.context",
        decision,
        ["continue", "transform"]
      );
      if (decision?.action === "transform") {
        try {
          assertModelContextEvent(decision.value);
        } catch (cause) {
          await this.#throwHookFailure(registration, "model.context", cause);
        }
        current = structuredClone([...decision.value.messages]);
      }
    }
    return current;
  }

  async transformModelStep(
    threadKey: string,
    messages: readonly ModelStepOutput[number][],
    history: readonly ModelMessage[],
    signal: AbortSignal = this.#abort.signal
  ): Promise<ModelStepOutput> {
    let current: ModelStepOutput = structuredClone([...messages]);
    for (const { registered, registration } of this.#handlers(
      "model.step.before"
    )) {
      const result = await this.#invoke(
        registration,
        "model.step.before",
        registered,
        { messages: structuredClone(current) },
        { history, signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["model.step.before"]
        | undefined;
      await this.#validateRequestResult(
        registration,
        "model.step.before",
        decision,
        ["continue", "transform"]
      );
      if (decision?.action === "transform") {
        try {
          assertModelStep(
            decision.value,
            "Plugin model.step.before transform must return a messages array."
          );
        } catch (cause) {
          await this.#throwHookFailure(
            registration,
            "model.step.before",
            cause
          );
        }
        current = structuredClone([...decision.value.messages]);
      }
    }
    return current;
  }

  wrapModel(model: LanguageModel, threadKey: string): LanguageModel {
    return wrapLanguageModel({
      middleware: {
        transformParams: async ({ params }) =>
          await this.#transformProviderParams(threadKey, params),
        wrapGenerate: async ({ doGenerate }) => {
          const response = await doGenerate();
          await this.#notifyProviderResponse(threadKey, response);
          return response;
        },
        wrapStream: async ({ doStream }) => {
          const response = await doStream();
          await this.#notifyProviderResponse(threadKey, response);
          return response;
        },
      },
      model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    });
  }

  clearThread(threadKey: string): void {
    for (const clear of this.#threadStateClearers) {
      clear(threadKey);
    }
  }

  dispose(): Promise<void> {
    this.#abort.abort();
    for (const registration of this.#registrations) {
      registration.state = "disposed";
      for (const subscription of registration.subscriptions) {
        subscription.unsubscribe();
      }
    }
    this.#registrations.length = 0;
    return Promise.resolve();
  }

  async #load(
    factory: PluginDefinition,
    index: number,
    timeoutMs: number
  ): Promise<void> {
    const registration: PluginRegistration = {
      handlers: [],
      index,
      state: "loading",
      subscriptions: [],
      tools: new Map(),
    };
    const factoryAbort = new AbortController();
    const factorySignal = AbortSignal.any([
      this.#abort.signal,
      factoryAbort.signal,
    ]);
    try {
      await withTimeout(
        Promise.resolve(
          factory(this.#api(registration), { signal: factorySignal })
        ),
        timeoutMs,
        factorySignal
      );
      this.#publish(registration);
      registration.state = "active";
      this.#registrations.push(registration);
    } catch (cause) {
      factoryAbort.abort(cause);
      registration.state = "disposed";
      for (const subscription of registration.subscriptions) {
        subscription.unsubscribe();
      }
      await this.#report(index, "factory", cause);
      throw new PluginInitializationError(index, cause);
    }
  }

  #api(registration: PluginRegistration): PluginAPI {
    return {
      on: (event, handler) => {
        this.#assertLoading(registration);
        const registered: RegisteredHandler = {
          active: true,
          event,
          handler: handler as unknown as PluginHandler<keyof PluginEventMap>,
        };
        registration.handlers.push(registered);
        const subscription = subscriptionFor(() => {
          registered.active = false;
        });
        registration.subscriptions.push(subscription);
        return subscription;
      },
      provide: ((capability: PluginCapability) => {
        this.#assertLoading(registration);
        if (capability.kind === "thread-scope") {
          return this.#threadScope(capability);
        }
        if (capability.kind === "tool") {
          if (registration.tools.has(capability.name)) {
            throw new TypeError(
              `Duplicate tool name ${JSON.stringify(capability.name)}.`
            );
          }
          registration.tools.set(capability.name, capability);
        } else {
          throw new TypeError("Unknown plugin capability.");
        }
        const subscription = subscriptionFor(() => {
          registration.tools.delete(capability.name);
          if (this.#tools[capability.name] === capability.tool) {
            delete this.#tools[capability.name];
          }
        });
        registration.subscriptions.push(subscription);
        return subscription;
      }) as PluginAPI["provide"],
    };
  }

  #assertLoading(registration: PluginRegistration): void {
    if (registration.state !== "loading") {
      throw new PluginRegistrationClosedError(registration.index);
    }
  }

  #threadScope<T>(capability: ThreadScopeCapability<T>): ThreadStateHandle<T> {
    const states = new Map<string, T>();
    this.#threadStateClearers.add((key) => states.delete(key));
    return {
      get: (thread) => {
        if (!states.has(thread.key)) {
          states.set(thread.key, capability.create());
        }
        return states.get(thread.key) as T;
      },
    };
  }

  #publish(registration: PluginRegistration): void {
    for (const name of registration.tools.keys()) {
      if (name in this.#tools) {
        throw new TypeError(`Duplicate tool name ${JSON.stringify(name)}.`);
      }
    }
    for (const [name, capability] of registration.tools) {
      this.#tools[name] = capability.tool;
    }
  }

  *#handlers<E extends keyof PluginEventMap>(
    event: E
  ): Generator<{
    readonly registered: RegisteredHandler;
    readonly registration: PluginRegistration;
  }> {
    for (const registration of this.#registrations) {
      if (registration.state !== "active") {
        continue;
      }
      for (const registered of registration.handlers) {
        if (registered.active && registered.event === event) {
          yield { registered, registration };
        }
      }
    }
  }

  async #notify<E extends keyof PluginEventMap>(
    eventName: E,
    event: PluginEventMap[E],
    context: PluginInvocationContext
  ): Promise<void> {
    for (const { registered, registration } of this.#handlers(eventName)) {
      await this.#invoke(
        registration,
        eventName,
        registered,
        cloneEvent(event),
        context
      );
    }
  }

  async #invoke(
    registration: PluginRegistration,
    eventName: keyof PluginEventMap,
    registered: RegisteredHandler,
    event: PluginEventMap[keyof PluginEventMap],
    context: PluginInvocationContext
  ): Promise<unknown> {
    try {
      return await withTimeout(
        Promise.resolve(
          registered.handler(event, {
            history: structuredClone([...context.history]),
            signal: context.signal,
            thread: { key: context.threadKey },
          } as PluginEventContext)
        ),
        this.#hookTimeoutMs,
        context.signal,
        { abortOnSignal: !isTerminalNotification(eventName) }
      );
    } catch (cause) {
      await this.#throwHookFailure(registration, eventName, cause);
    }
  }

  async #transformProviderParams(
    threadKey: string,
    params: ProviderCallOptions
  ): Promise<ProviderCallOptions> {
    let current = params;
    for (const { registered, registration } of this.#handlers(
      "provider.request.before"
    )) {
      const signal = params.abortSignal ?? this.#abort.signal;
      const result = await this.#invoke(
        registration,
        "provider.request.before",
        registered,
        { params: current },
        { history: [], signal, threadKey }
      );
      const decision = result as
        | PluginRequestResultMap["provider.request.before"]
        | undefined;
      await this.#validateRequestResult(
        registration,
        "provider.request.before",
        decision,
        ["continue", "transform"]
      );
      if (decision?.action === "transform") {
        try {
          assertProviderBeforeRequestEvent(decision.value);
        } catch (cause) {
          await this.#throwHookFailure(
            registration,
            "provider.request.before",
            cause
          );
        }
        current = decision.value.params;
      }
    }
    return current;
  }

  #notifyProviderResponse(threadKey: string, response: unknown): Promise<void> {
    return this.#notify(
      "provider.response.after",
      { response },
      { history: [], signal: this.#abort.signal, threadKey }
    );
  }

  async #invalidResult(
    registration: PluginRegistration,
    event: keyof PluginEventMap,
    message: string
  ): Promise<PluginHookError> {
    const cause = new TypeError(message);
    await this.#report(registration.index, "handler", cause, event);
    return new PluginHookError(registration.index, event, cause);
  }

  async #validateRequestResult(
    registration: PluginRegistration,
    event: keyof PluginRequestResultMap,
    result: unknown,
    actions: readonly string[]
  ): Promise<void> {
    if (result === undefined) {
      return;
    }
    if (
      result &&
      typeof result === "object" &&
      "action" in result &&
      typeof result.action === "string" &&
      actions.includes(result.action)
    ) {
      if (result.action === "transform" && !("value" in result)) {
        throw await this.#invalidResult(
          registration,
          event,
          `Plugin ${event} transform result is missing value.`
        );
      }
      if (
        result.action === "block" &&
        "reason" in result &&
        result.reason !== undefined &&
        typeof result.reason !== "string"
      ) {
        throw await this.#invalidResult(
          registration,
          event,
          `Plugin ${event} block reason must be a string.`
        );
      }
      return;
    }
    throw await this.#invalidResult(
      registration,
      event,
      `Plugin ${event} handler returned an invalid result.`
    );
  }

  async #throwHookFailure(
    registration: PluginRegistration,
    event: keyof PluginEventMap,
    cause: unknown
  ): Promise<never> {
    await this.#report(registration.index, "handler", cause, event);
    throw new PluginHookError(registration.index, event, cause);
  }

  async #report(
    pluginIndex: number,
    phase: "factory" | "handler",
    cause: unknown,
    event?: string
  ): Promise<void> {
    try {
      await this.#diagnostics.report({
        cause,
        code: `plugin.${phase}_failed`,
        ...(event ? { event } : {}),
        level: "error",
        phase,
        pluginIndex,
      });
    } catch {
      // Diagnostics must never replace the original plugin failure.
    }
  }
}

function assertInputAcceptEvent(
  value: unknown
): asserts value is InputAcceptEvent {
  if (
    !(value && typeof value === "object" && "type" in value) ||
    (value.type !== "runtime-input" && value.type !== "user-input")
  ) {
    throw new TypeError(
      "Plugin input.accept transform must return a user-input or runtime-input event."
    );
  }
}

function assertTurnStartEvent(
  value: unknown
): asserts value is Extract<AgentEvent, { type: "turn-start" }> {
  if (!(value && typeof value === "object" && "type" in value)) {
    throw new TypeError(
      "Plugin turn.start.before transform must return a turn-start event."
    );
  }
  if (value.type !== "turn-start") {
    throw new TypeError(
      "Plugin turn.start.before transform must return a turn-start event."
    );
  }
}

function assertToolResultEvent(value: unknown): asserts value is ToolResult {
  if (
    !(
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "tool-result" &&
      "toolCallId" in value &&
      typeof value.toolCallId === "string" &&
      "toolName" in value &&
      typeof value.toolName === "string" &&
      "output" in value
    )
  ) {
    throw new TypeError(
      "Plugin tool.result transform must return a complete tool-result event."
    );
  }
}

function assertModelContextEvent(
  value: unknown
): asserts value is { readonly messages: readonly ModelMessage[] } {
  assertModelMessages(
    value,
    "Plugin model.context transform must return a messages array."
  );
}

function assertModelStep(
  value: unknown,
  message: string
): asserts value is { readonly messages: ModelStepOutput } {
  if (!(value && typeof value === "object" && "messages" in value)) {
    throw new TypeError(message);
  }
  if (
    !(
      Array.isArray(value.messages) &&
      value.messages.every(
        (item) =>
          isModelMessage(item) &&
          (item.role === "assistant" || item.role === "tool")
      )
    )
  ) {
    throw new TypeError(message);
  }
}

function assertModelMessages(
  value: unknown,
  message: string
): asserts value is { readonly messages: readonly ModelMessage[] } {
  if (!(value && typeof value === "object" && "messages" in value)) {
    throw new TypeError(message);
  }
  if (
    !(Array.isArray(value.messages) && value.messages.every(isModelMessage))
  ) {
    throw new TypeError(message);
  }
}

function isModelMessage(value: unknown): value is ModelMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "role" in value &&
      (value.role === "system" ||
        value.role === "user" ||
        value.role === "assistant" ||
        value.role === "tool") &&
      "content" in value
  );
}

function assertProviderBeforeRequestEvent(
  value: unknown
): asserts value is { readonly params: ProviderCallOptions } {
  if (
    !(
      value &&
      typeof value === "object" &&
      "params" in value &&
      value.params &&
      typeof value.params === "object"
    )
  ) {
    throw new TypeError(
      "Plugin provider.request.before transform must return provider params."
    );
  }
}

function assertCompactionInput(
  value: unknown
): asserts value is ThreadCompactionInput {
  if (
    !(
      value &&
      typeof value === "object" &&
      "startSeq" in value &&
      typeof value.startSeq === "number" &&
      "endSeqExclusive" in value &&
      typeof value.endSeqExclusive === "number" &&
      "summary" in value &&
      typeof value.summary === "string"
    )
  ) {
    throw new TypeError(
      "Plugin thread.compaction.before transform must return a compaction input."
    );
  }
}

function cloneEvent<T>(event: T): T {
  try {
    return structuredClone(event);
  } catch {
    return event;
  }
}

function subscriptionFor(dispose: () => void): Subscription {
  let active = true;
  return {
    unsubscribe: () => {
      if (!active) {
        return;
      }
      active = false;
      dispose();
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  options: { readonly abortOnSignal?: boolean } = {}
): Promise<T> {
  const abortOnSignal = options.abortOnSignal ?? true;
  if (abortOnSignal && signal.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Plugin operation timed out.")),
      timeoutMs
    );
    if (abortOnSignal) {
      abort = () => reject(signal.reason ?? new Error("Aborted"));
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}

function isTerminalNotification(event: keyof PluginEventMap): boolean {
  return (
    event === "turn.abort" ||
    event === "turn.end" ||
    event === "turn.error" ||
    event === "turn.settled"
  );
}
