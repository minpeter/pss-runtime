import type { ModelMessage, ToolSet } from "ai";
import type { SessionStore } from "../session/store/types";

export type AgentPluginMaybePromise<T> = Promise<T> | T;

export type AgentContextTransform = (context: {
  readonly history: readonly ModelMessage[];
  readonly sessionKey: string;
  readonly signal: AbortSignal;
}) => AgentPluginMaybePromise<readonly ModelMessage[]>;

export type AgentPluginEventName = "afterTurn";

export interface AgentPluginEvent {
  readonly history: readonly ModelMessage[];
  readonly sessionKey: string;
  readonly signal: AbortSignal;
  readonly type: AgentPluginEventName;
}

export type AgentPluginHandler = (
  event: AgentPluginEvent
) => AgentPluginMaybePromise<void>;

export interface AgentPlugin {
  readonly name: string;
  setup(host: AgentPluginHost): AgentPluginMaybePromise<void>;
}

export interface AgentPluginHost {
  on(event: AgentPluginEventName, handler: AgentPluginHandler): void;
  registerSessionStore(store: SessionStore): void;
  registerTools(tools: ToolSet): void;
  transformContext(handler: AgentContextTransform): void;
}

export function definePlugin(plugin: AgentPlugin): AgentPlugin {
  return plugin;
}
