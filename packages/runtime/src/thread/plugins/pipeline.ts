import type { ModelMessage } from "ai";
import type {
  RuntimeToolCapability,
  RuntimeToolRetryPolicy,
} from "../../llm/llm";
import type {
  AgentEvent,
  RuntimeInput,
  UserMessage,
  UserText,
} from "../protocol/events";

export type {
  InputEventMeta,
  InputSource,
} from "../input/input-meta-types";

type MaybePromise<T> = PromiseLike<T> | T;
type AgentEventHistory = readonly ModelMessage[];

export type InterceptableAgentEvent = RuntimeInput | UserMessage | UserText;

export type AgentPluginInterceptResult =
  | { readonly action: "continue" }
  | { readonly action: "handled" }
  | { readonly action: "transform"; readonly event: InterceptableAgentEvent };

export type AgentPluginResult = AgentPluginInterceptResult | undefined;

export type AgentToolCallResult =
  | { readonly action: "continue" }
  | { readonly action: "needs-recovery" };

export interface AgentEventContext {
  readonly event: AgentEvent;
  readonly history: AgentEventHistory;
  readonly signal?: AbortSignal;
}

export interface AgentToolCallContext {
  readonly attempt: number;
  readonly capabilities: readonly RuntimeToolCapability[];
  readonly history: AgentEventHistory;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly policy: RuntimeToolRetryPolicy;
  readonly signal?: AbortSignal;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface AgentPlugin {
  readonly name?: string;
  readonly on?: (context: AgentEventContext) => MaybePromise<AgentPluginResult>;
  readonly onToolCall?: (
    context: AgentToolCallContext
  ) => MaybePromise<AgentToolCallResult | undefined>;
}

export type PluginPipelineResult =
  | { readonly event: AgentEvent; readonly kind: "emit" }
  | { readonly kind: "handled" };

export function runPluginsForEvent(
  plugins: readonly AgentPlugin[],
  context: AgentEventContext,
  options: { readonly observeOnly?: boolean } = {}
): Promise<PluginPipelineResult> {
  return runPluginPipeline(plugins, context, options.observeOnly === true);
}

export async function runPluginsForToolCall(
  plugins: readonly AgentPlugin[],
  context: AgentToolCallContext
): Promise<AgentToolCallResult> {
  for (const plugin of plugins) {
    const handler = plugin.onToolCall;
    if (!handler) {
      continue;
    }

    const result = normalizeToolCallResult(await handler(context));
    if (!result || result.action === "continue") {
      continue;
    }

    return result;
  }

  return { action: "continue" };
}

function isInterceptableEvent(
  event: AgentEvent
): event is InterceptableAgentEvent {
  return event.type === "user-input" || event.type === "runtime-input";
}

function normalizeInterceptResult(
  result: AgentPluginResult | undefined
): AgentPluginInterceptResult | undefined {
  if (result === undefined || result === null || typeof result !== "object") {
    return;
  }

  if (result.action === "continue" || result.action === "handled") {
    return result;
  }

  if (result.action === "transform") {
    return result;
  }

  return;
}

function normalizeToolCallResult(
  result: AgentToolCallResult | undefined
): AgentToolCallResult | undefined {
  if (result === undefined || result === null || typeof result !== "object") {
    return;
  }

  if (result.action === "continue" || result.action === "needs-recovery") {
    return result;
  }

  return;
}

async function runPluginPipeline(
  plugins: readonly AgentPlugin[],
  context: AgentEventContext,
  observeOnly: boolean
): Promise<PluginPipelineResult> {
  let currentEvent = context.event;

  for (const plugin of plugins) {
    const handler = plugin.on;
    if (!handler) {
      continue;
    }

    const result = await handler({ ...context, event: currentEvent });
    if (observeOnly || !isInterceptableEvent(currentEvent)) {
      continue;
    }

    const intercept = normalizeInterceptResult(result);
    if (!intercept || intercept.action === "continue") {
      continue;
    }

    if (intercept.action === "handled") {
      return { kind: "handled" };
    }

    currentEvent = intercept.event;
  }

  return { kind: "emit", event: currentEvent };
}
