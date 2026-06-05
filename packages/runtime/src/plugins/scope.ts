import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelMessage } from "ai";
import type { AgentCompactionOverlay } from "../session/snapshot";

export interface AgentPluginScope {
  readonly getCompactions: () => readonly AgentCompactionOverlay[];
  readonly getPluginState: (pluginName: string) => unknown;
  readonly sessionKey: string;
  readonly setCompactions: (
    compactions: readonly AgentCompactionOverlay[]
  ) => void;
  readonly setPluginState: (pluginName: string, state: unknown) => void;
  readonly signal: AbortSignal;
  readonly summarize: (messages: readonly ModelMessage[]) => Promise<string>;
}

const storage = new AsyncLocalStorage<AgentPluginScope>();

export function getActiveAgentPluginScope(): AgentPluginScope | undefined {
  return storage.getStore();
}

export function runWithAgentPluginScope<T>(
  scope: AgentPluginScope,
  callback: () => T
): T {
  return storage.run(scope, callback);
}
