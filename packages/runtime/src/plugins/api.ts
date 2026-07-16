import type { LanguageModelMiddleware, ModelMessage, Tool } from "ai";
import type { CanonicalHistoryPolicy } from "../thread/plugins/canonical-history";
import type { AgentEvent } from "../thread/protocol/events";
import type { ThreadCompactionInput } from "../thread/state/thread-state";

export type MaybePromise<T> = PromiseLike<T> | T;

export interface PluginFactoryContext {
  readonly signal: AbortSignal;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface PluginThread {
  readonly key: string;
}

export interface PluginEventContext {
  readonly history: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly thread: PluginThread;
}

type AgentEventOf<T extends AgentEvent["type"]> = Extract<
  AgentEvent,
  { type: T }
>;

export type InputAcceptEvent = AgentEventOf<"runtime-input" | "user-input">;
export type PluginMessageEvent = AgentEventOf<
  "assistant-output" | "assistant-reasoning"
>;
export type PluginToolCallRetryPolicy =
  | "idempotent"
  | "manual-recovery"
  | "pure";
export interface PluginToolCallBeforeEvent {
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly policy: PluginToolCallRetryPolicy;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly type: "tool.call.before";
}
export type PluginToolResultEvent = AgentEventOf<"tool-result">;
export type PluginTurnSettledEvent = AgentEventOf<
  "turn-abort" | "turn-end" | "turn-error"
>;

export interface ModelContextEvent {
  readonly messages: readonly ModelMessage[];
}

export interface ProviderBeforeRequestEvent {
  readonly params: ProviderCallOptions;
}

export type ProviderCallOptions = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"];

export interface PluginEventMap {
  readonly "input.accept": InputAcceptEvent;
  readonly "message.end": PluginMessageEvent;
  readonly "message.start": PluginMessageEvent;
  readonly "message.update": PluginMessageEvent;
  readonly "model.context": ModelContextEvent;
  readonly "provider.request.before": ProviderBeforeRequestEvent;
  readonly "provider.response.after": { readonly response: unknown };
  readonly "step.end": AgentEventOf<"step-end">;
  readonly "step.start": AgentEventOf<"step-start">;
  readonly "thread.compaction.after": { readonly input: ThreadCompactionInput };
  readonly "thread.compaction.before": {
    readonly input: ThreadCompactionInput;
  };
  readonly "thread.shutdown": Record<string, never>;
  readonly "thread.start": Record<string, never>;
  readonly "tool.call.before": PluginToolCallBeforeEvent;
  readonly "tool.execution.end": PluginToolResultEvent;
  readonly "tool.execution.start": PluginToolCallBeforeEvent;
  readonly "tool.result": PluginToolResultEvent;
  readonly "turn.abort": AgentEventOf<"turn-abort">;
  readonly "turn.end": AgentEventOf<"turn-end">;
  readonly "turn.error": AgentEventOf<"turn-error">;
  readonly "turn.settled": PluginTurnSettledEvent;
  readonly "turn.start": AgentEventOf<"turn-start">;
  readonly "turn.start.before": AgentEventOf<"turn-start">;
}

export interface PluginContinue {
  readonly action: "continue";
}
export interface PluginEventTransform<T> {
  readonly action: "transform";
  readonly value: T;
}

export interface PluginRequestResultMap {
  readonly "input.accept":
    | PluginContinue
    | { readonly action: "handled" }
    | PluginEventTransform<InputAcceptEvent>;
  readonly "model.context":
    | PluginContinue
    | PluginEventTransform<ModelContextEvent>;
  readonly "provider.request.before":
    | PluginContinue
    | PluginEventTransform<ProviderBeforeRequestEvent>;
  readonly "thread.compaction.before":
    | PluginContinue
    | { readonly action: "cancel" }
    | PluginEventTransform<{ readonly input: ThreadCompactionInput }>;
  readonly "tool.call.before":
    | PluginContinue
    | { readonly action: "block"; readonly reason?: string }
    | { readonly action: "needs-recovery" };
  readonly "tool.result":
    | PluginContinue
    | PluginEventTransform<PluginToolResultEvent>;
  readonly "turn.start.before":
    | PluginContinue
    | PluginEventTransform<AgentEventOf<"turn-start">>;
}

export type PluginRequestEvent = keyof PluginRequestResultMap;
export type PluginNotificationEvent = Exclude<
  keyof PluginEventMap,
  PluginRequestEvent
>;

export type PluginHandler<E extends keyof PluginEventMap> = (
  event: PluginEventMap[E],
  context: PluginEventContext
) => MaybePromise<
  E extends PluginRequestEvent ? PluginRequestResultMap[E] | undefined : void
>;

const capabilityDescriptor: unique symbol = Symbol("pss.plugin.capability");

export interface ToolCapability {
  readonly kind: "tool";
  readonly name: string;
  readonly tool: Tool;
  readonly [capabilityDescriptor]: "tool";
}

export interface HistoryPolicyCapability {
  readonly kind: "history-policy";
  readonly policy: CanonicalHistoryPolicy;
  readonly [capabilityDescriptor]: "history-policy";
}

export interface ThreadScopeCapability<T> {
  readonly create: () => T;
  readonly kind: "thread-scope";
  readonly [capabilityDescriptor]: "thread-scope";
}

export type PluginCapability =
  | HistoryPolicyCapability
  | ThreadScopeCapability<unknown>
  | ToolCapability;

export interface ThreadStateHandle<T> {
  get(thread: PluginThread): T;
}

export const registerTool = (input: {
  readonly name: string;
  readonly tool: Tool;
}): ToolCapability => ({
  [capabilityDescriptor]: "tool",
  kind: "tool",
  ...input,
});

export const historyPolicy = (
  policy: CanonicalHistoryPolicy
): HistoryPolicyCapability => ({
  [capabilityDescriptor]: "history-policy",
  kind: "history-policy",
  policy,
});

export const threadScope = <T>(create: () => T): ThreadScopeCapability<T> => ({
  [capabilityDescriptor]: "thread-scope",
  create,
  kind: "thread-scope",
});

export interface PluginAPI {
  on<E extends keyof PluginEventMap>(
    event: E,
    handler: PluginHandler<E>
  ): Subscription;
  provide(capability: HistoryPolicyCapability | ToolCapability): Subscription;
  provide<T>(capability: ThreadScopeCapability<T>): ThreadStateHandle<T>;
}

export type PluginFactory = (
  api: PluginAPI,
  context: PluginFactoryContext
) => MaybePromise<void>;

export type PluginDefinition = PluginFactory;

export function definePlugin(factory: PluginFactory): PluginDefinition {
  if (typeof factory !== "function") {
    throw new TypeError("Plugin factory must be a function.");
  }
  return factory;
}
