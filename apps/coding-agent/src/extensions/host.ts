import type {
  Agent,
  AgentHooks,
  ThreadStateMigration,
} from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import type { TuiCommand } from "../tui/command";
import type { ToolRendererMap } from "../tui/tool-call-view";
import { composeAgentHooks, type RegisteredAgentHooks } from "./compose-hooks";
import { CodingAgentExtensionError } from "./error";
import { normalizeCodingAgentExtension } from "./factory";
import {
  DEFAULT_EXTENSION_TIMEOUT_MS,
  validateExtensionHostOptions,
} from "./host-validation";
import type {
  CodingAgentExtension,
  CodingAgentExtensionActivationContext,
  CodingAgentExtensionCleanup,
  CodingAgentExtensionHostOptions,
  CodingAgentExtensionInput,
  CodingAgentExtensionMode,
  CodingAgentExtensionRegistry,
} from "./types";

const THREAD_MIGRATION_ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;

export class CodingAgentExtensionHost {
  readonly #commands: TuiCommand[] = [];
  readonly #controller = new AbortController();
  readonly #extensions: readonly CodingAgentExtension[];
  readonly #hookRegistrations: RegisteredAgentHooks[] = [];
  readonly #instructionFragments: string[] = [];
  readonly #timeoutMs: number;
  readonly #toolRenderers: ToolRendererMap = {};
  readonly #tools: ToolSet = {};
  readonly #threadMigrations: ThreadStateMigration[] = [];
  #activated = false;
  #cleanups: { cleanup: CodingAgentExtensionCleanup; id: string }[] = [];
  #disposed = false;

  private constructor(
    extensions: readonly CodingAgentExtension[],
    options: CodingAgentExtensionHostOptions
  ) {
    this.#extensions = extensions;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS;
  }

  static async create(
    extensions: readonly CodingAgentExtensionInput[],
    options: CodingAgentExtensionHostOptions = {}
  ): Promise<CodingAgentExtensionHost> {
    validateExtensionHostOptions(extensions, options);
    const host = new CodingAgentExtensionHost(
      extensions.map(normalizeCodingAgentExtension),
      options
    );
    try {
      await host.#configure();
      return host;
    } catch (error) {
      await host.dispose();
      throw error;
    }
  }

  get commands(): readonly TuiCommand[] {
    return [...this.#commands];
  }

  get hooks(): AgentHooks | undefined {
    return this.#hookRegistrations.length === 0
      ? undefined
      : composeAgentHooks(this.#hookRegistrations);
  }

  get instructionFragments(): readonly string[] {
    return [...this.#instructionFragments];
  }

  get toolRenderers(): ToolRendererMap {
    return { ...this.#toolRenderers };
  }

  get tools(): ToolSet {
    return { ...this.#tools };
  }

  get threadMigrations(): readonly ThreadStateMigration[] {
    return [...this.#threadMigrations];
  }

  async activate(agent: Agent, mode: CodingAgentExtensionMode): Promise<void> {
    this.#assertUsable();
    if (this.#activated) {
      throw new Error("Coding agent extensions are already active");
    }
    this.#activated = true;
    const context: CodingAgentExtensionActivationContext = {
      agent,
      mode,
      signal: this.#controller.signal,
    };
    try {
      for (const extension of this.#extensions) {
        if (!extension.activate) {
          continue;
        }
        const cleanup = await this.#run(extension.id, "activate", () =>
          extension.activate?.(context)
        );
        if (cleanup) {
          this.#cleanups.push({ cleanup, id: extension.id });
        }
      }
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#controller.abort();
    const failures: unknown[] = [];
    for (const { cleanup, id } of this.#cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(new CodingAgentExtensionError(id, "dispose", error));
      }
    }
    this.#cleanups = [];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Coding agent extension cleanup failed"
      );
    }
  }

  async #configure(): Promise<void> {
    for (const extension of this.#extensions) {
      let open = true;
      const assertOpen = () => {
        if (!open) {
          throw new Error(
            `Coding agent extension "${extension.id}" registration is closed`
          );
        }
      };
      const registry = this.#registry(extension.id, assertOpen);
      try {
        await this.#run(extension.id, "configure", () =>
          extension.configure(registry, {
            signal: this.#controller.signal,
          })
        );
      } finally {
        open = false;
      }
    }
  }

  #registry(
    extensionId: string,
    assertOpen: () => void
  ): CodingAgentExtensionRegistry {
    return {
      commands: {
        register: (command) => {
          assertOpen();
          if (this.#commands.some(({ name }) => name === command.name)) {
            throw new Error(`Duplicate command "${command.name}"`);
          }
          this.#commands.push(command);
        },
      },
      instructions: {
        append: (fragment) => {
          assertOpen();
          if (fragment.trim().length === 0) {
            throw new Error("Instruction fragment must not be empty");
          }
          this.#instructionFragments.push(fragment);
        },
      },
      runtime: {
        use: (hooks) => {
          assertOpen();
          this.#hookRegistrations.push({ extensionId, hooks });
        },
      },
      storage: {
        registerThreadMigration: (migration) => {
          assertOpen();
          if (migration.id.trim().length === 0) {
            throw new Error("Thread migration id must not be empty");
          }
          const id = `${extensionId}/${migration.id}`;
          if (!THREAD_MIGRATION_ID_PATTERN.test(id)) {
            throw new TypeError(`Invalid thread migration id: ${id}`);
          }
          if (
            !Number.isSafeInteger(migration.version) ||
            migration.version < 1
          ) {
            throw new TypeError(
              `Thread migration "${id}" version must be a positive integer`
            );
          }
          if (typeof migration.migrate !== "function") {
            throw new TypeError(
              `Thread migration "${id}" migrate must be a function`
            );
          }
          if (this.#threadMigrations.some((entry) => entry.id === id)) {
            throw new Error(`Duplicate thread migration id: ${id}`);
          }
          this.#threadMigrations.push({ ...migration, id });
        },
      },
      tools: {
        register: (name, tool) => {
          assertOpen();
          if (Object.hasOwn(this.#tools, name)) {
            throw new Error(`Duplicate tool "${name}"`);
          }
          this.#tools[name] = tool;
        },
      },
      tui: {
        registerToolRenderer: (toolName, renderer) => {
          assertOpen();
          if (Object.hasOwn(this.#toolRenderers, toolName)) {
            throw new Error(`Duplicate tool renderer "${toolName}"`);
          }
          this.#toolRenderers[toolName] = renderer;
        },
      },
    };
  }

  async #run<Result>(
    extensionId: string,
    phase: "activate" | "configure",
    callback: () => Promise<Result> | Result
  ): Promise<Result> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        callback(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.#controller.abort();
            reject(
              new Error(
                `Coding agent extension timed out after ${this.#timeoutMs}ms`
              )
            );
          }, this.#timeoutMs);
        }),
      ]);
    } catch (error) {
      throw new CodingAgentExtensionError(extensionId, phase, error);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error("Coding agent extension host is disposed");
    }
  }
}

export async function createCodingAgentExtensionHost(
  extensions: readonly CodingAgentExtensionInput[],
  options?: CodingAgentExtensionHostOptions
): Promise<CodingAgentExtensionHost> {
  return await CodingAgentExtensionHost.create(extensions, options);
}
