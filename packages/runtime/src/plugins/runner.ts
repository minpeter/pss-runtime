import type { ToolSet } from "ai";
import type { Llm } from "../llm";
import type { SessionStore } from "../session/store/types";
import { type AgentPluginScope, runWithAgentPluginScope } from "./scope";
import type {
  AgentContextTransform,
  AgentPlugin,
  AgentPluginEventName,
  AgentPluginHandler,
} from "./types";

interface SessionStoreRegistration {
  readonly pluginName: string;
  readonly store: SessionStore;
}

interface ToolRegistration {
  readonly pluginName: string;
  readonly tools: ToolSet;
}

export interface ResolvedAgentPlugins {
  readonly contextTransforms: readonly AgentContextTransform[];
  readonly eventHandlers: ReadonlyMap<
    AgentPluginEventName,
    readonly AgentPluginHandler[]
  >;
  readonly sessionStore?: SessionStoreRegistration;
  readonly tools?: ToolSet;
}

export async function resolveAgentPlugins({
  callerTools,
  plugins,
}: {
  readonly callerTools?: ToolSet;
  readonly plugins?: readonly AgentPlugin[];
}): Promise<ResolvedAgentPlugins> {
  const contextTransforms: AgentContextTransform[] = [];
  const eventHandlers = new Map<AgentPluginEventName, AgentPluginHandler[]>();
  const sessionStores: SessionStoreRegistration[] = [];
  const toolRegistrations: ToolRegistration[] = [];

  for (const plugin of plugins ?? []) {
    try {
      await plugin.setup({
        on: (event, handler) => {
          const existing = eventHandlers.get(event) ?? [];
          eventHandlers.set(event, [...existing, handler]);
        },
        registerSessionStore: (store) => {
          sessionStores.push({ pluginName: plugin.name, store });
        },
        registerTools: (tools) => {
          toolRegistrations.push({ pluginName: plugin.name, tools });
        },
        transformContext: (handler) => {
          contextTransforms.push(handler);
        },
      });
    } catch (error) {
      throw new AgentPluginSetupError(plugin.name, error);
    }
  }

  if (sessionStores.length > 1) {
    const pluginNames = sessionStores
      .map((registration) => registration.pluginName)
      .join(", ");
    throw new AgentPluginConflictError(
      `Agent.create: multiple session persistence plugins registered (${pluginNames}).`
    );
  }

  return {
    contextTransforms,
    eventHandlers,
    sessionStore: sessionStores[0],
    tools: mergeTools(callerTools, toolRegistrations),
  };
}

function mergeTools(
  callerTools: ToolSet | undefined,
  registrations: readonly ToolRegistration[]
): ToolSet | undefined {
  if (!callerTools && registrations.length === 0) {
    return;
  }

  const merged: ToolSet = {};
  const claimedBy = new Map<string, string>();
  addTools(merged, claimedBy, callerTools, "caller");

  for (const registration of registrations) {
    addTools(
      merged,
      claimedBy,
      registration.tools,
      `plugin ${registration.pluginName}`
    );
  }

  return merged;
}

function addTools(
  merged: ToolSet,
  claimedBy: Map<string, string>,
  tools: ToolSet | undefined,
  owner: string
): void {
  if (!tools) {
    return;
  }

  for (const name of Object.keys(tools)) {
    const existingOwner = claimedBy.get(name);
    if (existingOwner) {
      throw new AgentPluginConflictError(
        `Agent.create: duplicate tool ${JSON.stringify(
          name
        )} registered by ${owner}; already registered by ${existingOwner}.`
      );
    }

    const value = tools[name];
    if (value) {
      merged[name] = value;
      claimedBy.set(name, owner);
    }
  }
}

export function wrapLlmWithContextTransforms({
  createScope,
  llm,
  sessionKey,
  transforms,
}: {
  readonly llm: Llm;
  readonly createScope?: (signal: AbortSignal) => AgentPluginScope;
  readonly sessionKey: string;
  readonly transforms: readonly AgentContextTransform[];
}): Llm {
  if (transforms.length === 0 && !createScope) {
    return llm;
  }

  return ({ history, signal }) => {
    const invoke = async () => {
      let transformedHistory: readonly (typeof history)[number][] = history;
      for (const transform of transforms) {
        transformedHistory = await transform({
          history: transformedHistory,
          sessionKey,
          signal,
        });
      }

      return llm({ history: transformedHistory, signal });
    };

    const scope = createScope?.(signal);
    return scope ? runWithAgentPluginScope(scope, invoke) : invoke();
  };
}

export class AgentPluginConflictError extends Error {
  readonly name = "AgentPluginConflictError";
}

export class AgentPluginSetupError extends Error {
  readonly name = "AgentPluginSetupError";

  constructor(pluginName: string, cause: unknown) {
    super(`Agent plugin ${JSON.stringify(pluginName)} setup failed`, {
      cause,
    });
  }
}
