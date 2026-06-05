import type { ToolSet } from "ai";
import type { SessionStore } from "../session/store/types";
import type {
  AgentContextTransform,
  AgentPlugin,
  AgentPluginEventName,
  AgentPluginStoredHandler,
} from "./types";
import { isAgentPluginEventName } from "./types";

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
    readonly AgentPluginStoredHandler[]
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
  const eventHandlers = new Map<
    AgentPluginEventName,
    AgentPluginStoredHandler[]
  >();
  const sessionStores: SessionStoreRegistration[] = [];
  const toolRegistrations: ToolRegistration[] = [];

  for (const plugin of plugins ?? []) {
    try {
      await plugin.setup({
        on: (event, handler) => {
          if (!isAgentPluginEventName(event)) {
            throw new AgentPluginUnknownEventError(plugin.name, event);
          }

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

export class AgentPluginConflictError extends Error {
  readonly name = "AgentPluginConflictError";
}

export class AgentPluginSetupError extends Error {
  readonly name = "AgentPluginSetupError";

  constructor(pluginName: string, cause: unknown) {
    super(
      `Agent plugin ${JSON.stringify(pluginName)} setup failed${formatSetupCause(
        cause
      )}`,
      { cause }
    );
  }
}

export class AgentPluginUnknownEventError extends Error {
  readonly name = "AgentPluginUnknownEventError";

  constructor(pluginName: string, event: unknown) {
    super(
      `unknown plugin event ${JSON.stringify(event)} registered by ${JSON.stringify(
        pluginName
      )}`
    );
  }
}

function formatSetupCause(cause: unknown): string {
  return cause instanceof Error ? `: ${cause.message}` : "";
}
