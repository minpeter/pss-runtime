import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelMessage } from "ai";
import type { AgentInput } from "../session/input";
import type { AgentRun } from "../session/run";
import type { AgentCompactionOverlay } from "../session/snapshot";
import type { AgentPluginEventName, AgentPluginStoredHandler } from "./types";

export type AgentPluginEventHandlerMap = ReadonlyMap<
  AgentPluginEventName,
  readonly AgentPluginStoredHandler[]
>;

export interface AgentPluginScope {
  readonly eventHandlers?: AgentPluginEventHandlerMap;
  readonly getCompactions: () => readonly AgentCompactionOverlay[];
  readonly getPluginState: (pluginName: string) => unknown;
  readonly history: () => readonly ModelMessage[];
  readonly overlay: (input: AgentInput) => Promise<AgentRun>;
  readonly sessionKey: string;
  readonly setCompactions: (
    compactions: readonly AgentCompactionOverlay[]
  ) => void;
  readonly setPluginState: (pluginName: string, state: unknown) => void;
  readonly signal: AbortSignal;
  readonly steer: (input: AgentInput) => Promise<AgentRun>;
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
