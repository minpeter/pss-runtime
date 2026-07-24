import type {
  AgentEvent,
  AgentHooks,
  ThreadStateMigration,
} from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import type { RegisteredAgentHooks } from "./compose-hooks";
import type { RegisteredCodingAgentExtensionEvent } from "./events";
import type {
  CodingAgentExtensionContribution,
  CodingAgentExtensionEventContext,
  CodingAgentExtensionEventHandler,
  CodingAgentExtensionRegistry,
} from "./types";

const THREAD_MIGRATION_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;
const UNSAFE_TOOL_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const EXTENSION_EVENT_TYPES = Object.freeze({
  "assistant-output": true,
  "assistant-output-delta": true,
  "assistant-reasoning": true,
  "assistant-reasoning-delta": true,
  "model-usage": true,
  "runtime-input": true,
  "step-end": true,
  "step-start": true,
  "tool-call": true,
  "tool-call-input-delta": true,
  "tool-call-input-end": true,
  "tool-call-input-start": true,
  "tool-result": true,
  "turn-abort": true,
  "turn-end": true,
  "turn-error": true,
  "turn-start": true,
  "user-input": true,
} satisfies Record<AgentEvent["type"], true>);

interface ExtensionRegistryCollections {
  readonly commands: TuiCommand[];
  readonly events: RegisteredCodingAgentExtensionEvent[];
  readonly hooks: RegisteredAgentHooks[];
  readonly instructions: string[];
  readonly migrations: ThreadStateMigration[];
  readonly renderers: ToolRendererMap;
  readonly tools: ToolSet;
}

interface CreateExtensionRegistryOptions {
  readonly assertOpen: () => void;
  readonly collections: ExtensionRegistryCollections;
  readonly extensionId: string;
}

export function createCodingAgentExtensionRegistry({
  assertOpen,
  collections,
  extensionId,
}: CreateExtensionRegistryOptions): CodingAgentExtensionRegistry {
  const registerTool = (name: string, tool: ToolSet[string]) => {
    assertOpen();
    if (UNSAFE_TOOL_NAMES.has(name)) {
      throw new TypeError(`Unsafe tool name "${name}"`);
    }
    if (Object.hasOwn(collections.tools, name)) {
      throw new Error(`Duplicate tool "${name}"`);
    }
    collections.tools[name] = tool;
  };
  const use = (hooks: AgentHooks) => {
    assertOpen();
    collections.hooks.push({ extensionId, hooks });
  };
  return {
    commands: {
      register: (command) => {
        assertOpen();
        if (collections.commands.some(({ name }) => name === command.name)) {
          throw new Error(`Duplicate command "${command.name}"`);
        }
        collections.commands.push(command);
      },
    },
    instructions: {
      append: (fragment) => {
        assertOpen();
        if (fragment.trim().length === 0) {
          throw new Error("Instruction fragment must not be empty");
        }
        collections.instructions.push(fragment);
      },
    },
    on: (type, handler) => {
      registerEvent(collections.events, extensionId, type, handler, assertOpen);
    },
    provide: (contribution) => {
      provide(contribution, registerTool, assertOpen);
    },
    runtime: { use },
    storage: {
      registerThreadMigration: (migration) => {
        registerThreadMigration(
          collections.migrations,
          extensionId,
          migration,
          assertOpen
        );
      },
    },
    tools: { register: registerTool },
    tui: {
      registerToolRenderer: (toolName, renderer) => {
        assertOpen();
        if (Object.hasOwn(collections.renderers, toolName)) {
          throw new Error(`Duplicate tool renderer "${toolName}"`);
        }
        collections.renderers[toolName] = renderer;
      },
    },
    use,
  };
}

function provide(
  contribution: CodingAgentExtensionContribution,
  registerTool: (name: string, tool: ToolSet[string]) => void,
  assertOpen: () => void
): void {
  assertOpen();
  if (
    !contribution ||
    typeof contribution !== "object" ||
    !Object.hasOwn(contribution, "tools") ||
    !contribution.tools ||
    typeof contribution.tools !== "object" ||
    Array.isArray(contribution.tools)
  ) {
    throw new TypeError("Extension contribution must provide a tools object");
  }
  const keys = Object.keys(contribution);
  if (keys.length !== 1 || keys[0] !== "tools") {
    throw new TypeError("Extension contribution only supports tools");
  }
  for (const [name, tool] of Object.entries(contribution.tools)) {
    registerTool(name, tool);
  }
}

function registerEvent<Type extends AgentEvent["type"]>(
  events: RegisteredCodingAgentExtensionEvent[],
  extensionId: string,
  type: Type,
  handler: CodingAgentExtensionEventHandler<Type>,
  assertOpen: () => void
): void {
  assertOpen();
  if (!Object.hasOwn(EXTENSION_EVENT_TYPES, type)) {
    throw new TypeError(`Unknown extension event "${type}"`);
  }
  if (typeof handler !== "function") {
    throw new TypeError(`Extension event "${type}" handler must be a function`);
  }
  events.push({
    extensionId,
    invoke: async (
      event: AgentEvent,
      context: CodingAgentExtensionEventContext
    ) => {
      await handler(
        event as Extract<AgentEvent, { readonly type: Type }>,
        context
      );
    },
    type,
  });
}

function registerThreadMigration(
  migrations: ThreadStateMigration[],
  extensionId: string,
  migration: ThreadStateMigration,
  assertOpen: () => void
): void {
  assertOpen();
  if (migration.id.trim().length === 0) {
    throw new Error("Thread migration id must not be empty");
  }
  const id = `${extensionId}/${migration.id}`;
  if (!THREAD_MIGRATION_ID_PATTERN.test(id)) {
    throw new TypeError(`Invalid thread migration id: ${id}`);
  }
  if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
    throw new TypeError(
      `Thread migration "${id}" version must be a positive integer`
    );
  }
  if (typeof migration.migrate !== "function") {
    throw new TypeError(`Thread migration "${id}" migrate must be a function`);
  }
  if (migrations.some((entry) => entry.id === id)) {
    throw new Error(`Duplicate thread migration id: ${id}`);
  }
  migrations.push({ ...migration, id });
}
