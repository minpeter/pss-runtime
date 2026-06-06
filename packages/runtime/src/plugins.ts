import type { RuntimeLlmContext } from "./llm";
import type { AgentEvent } from "./session/events";

type MaybePromise<T> = PromiseLike<T> | T;
type AgentEventHistory = RuntimeLlmContext["history"];

export interface AgentEventContext {
  readonly event: AgentEvent;
  readonly history: AgentEventHistory;
  readonly signal?: AbortSignal;
}

export interface AgentPlugin {
  readonly events?: {
    readonly on?: (context: AgentEventContext) => MaybePromise<void>;
  };
  readonly name?: string;
}

export function runEventPlugins(
  plugins: readonly AgentPlugin[],
  context: AgentEventContext
): Promise<void> {
  return runPluginHandlers(plugins, (plugin) => plugin.events?.on, context);
}

async function runPluginHandlers<Context>(
  plugins: readonly AgentPlugin[],
  handlerFor: (
    plugin: AgentPlugin
  ) => ((context: Context) => MaybePromise<void>) | undefined,
  context: Context
): Promise<void> {
  for (const plugin of plugins) {
    const handler = handlerFor(plugin);
    if (handler) {
      await handler(context);
    }
  }
}
