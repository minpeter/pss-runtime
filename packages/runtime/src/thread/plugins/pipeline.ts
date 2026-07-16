import type { ModelMessage } from "ai";
import type { PluginToolCallBeforeEvent } from "../../plugins/api";
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
export type AgentPluginEvent = AgentEvent | PluginToolCallBeforeEvent;

export type AgentPluginInterceptResult =
  | { readonly action: "continue" }
  | { readonly action: "handled" }
  | { readonly action: "needs-recovery" }
  | { readonly action: "transform"; readonly event: InterceptableAgentEvent };

export type AgentPluginResult = AgentPluginInterceptResult | undefined;

export interface AgentEventContext {
  readonly event: AgentPluginEvent;
  readonly history: AgentEventHistory;
  readonly signal?: AbortSignal;
}

export interface AgentPlugin {
  readonly name?: string;
  readonly on?: (context: AgentEventContext) => MaybePromise<AgentPluginResult>;
}

export type PluginPipelineResult =
  | { readonly event: AgentPluginEvent; readonly kind: "emit" }
  | { readonly kind: "handled" }
  | { readonly kind: "needs-recovery" };

export function runPluginsForEvent(
  plugins: readonly AgentPlugin[],
  context: AgentEventContext,
  options: { readonly observeOnly?: boolean } = {}
): Promise<PluginPipelineResult> {
  return runPluginPipeline(plugins, context, options.observeOnly === true);
}

function isInterceptableEvent(
  event: AgentPluginEvent
): event is InterceptableAgentEvent {
  return event.type === "user-input" || event.type === "runtime-input";
}

function normalizeInterceptResult(
  result: AgentPluginResult | undefined
): AgentPluginInterceptResult | undefined {
  if (result === undefined || result === null || typeof result !== "object") {
    return;
  }

  if (
    result.action === "continue" ||
    result.action === "handled" ||
    result.action === "needs-recovery"
  ) {
    return result;
  }

  if (result.action === "transform") {
    return result;
  }

  return;
}

function eventForPluginHandler(event: AgentPluginEvent): AgentPluginEvent {
  return isPluginToolCallBeforeEvent(event) ? structuredClone(event) : event;
}

function canInterceptEvent(
  event: AgentPluginEvent,
  observeOnly: boolean
): boolean {
  if (observeOnly) {
    return false;
  }

  return isInterceptableEvent(event) || isPluginToolCallBeforeEvent(event);
}

function beforeToolCallPipelineResult(
  intercept: AgentPluginInterceptResult
): PluginPipelineResult | undefined {
  if (intercept.action === "needs-recovery") {
    return { kind: "needs-recovery" };
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

    const result = await handler({
      ...context,
      event: eventForPluginHandler(currentEvent),
    });
    if (!canInterceptEvent(currentEvent, observeOnly)) {
      continue;
    }

    const intercept = normalizeInterceptResult(result);
    if (!intercept || intercept.action === "continue") {
      continue;
    }

    if (isPluginToolCallBeforeEvent(currentEvent)) {
      const resultForBeforeTool = beforeToolCallPipelineResult(intercept);
      if (resultForBeforeTool) {
        return resultForBeforeTool;
      }

      continue;
    }

    if (intercept.action === "handled") {
      return { kind: "handled" };
    }

    if (
      intercept.action === "transform" &&
      isInterceptableEvent(currentEvent)
    ) {
      currentEvent = intercept.event;
    }
  }

  return { kind: "emit", event: currentEvent };
}

function isPluginToolCallBeforeEvent(
  event: AgentPluginEvent
): event is PluginToolCallBeforeEvent {
  return event.type === "tool.call.before";
}
