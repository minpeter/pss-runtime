import type { LanguageModel, ToolSet } from "ai";
import type { AgentHooks } from "./hooks";
import { type AgentToolChoice, createLlm, type Llm } from "./llm";
import type { UserInput } from "./session/events";
import type { AgentRun } from "./session/run";
import { type AgentInput, AgentSession } from "./session/session";
import { MemorySessionStore } from "./session/store/memory";
import type { SessionStore } from "./session/store/types";
import { createSubagentTools } from "./subagents";

interface AgentLanguageModelOptions {
  description?: string;
  hooks?: AgentHooks;
  instructions?: string;
  llm?: never;
  model: LanguageModel;
  name?: string;
  sessions?: AgentSessionOptions;
  subagents?: readonly Agent[];
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

interface AgentLlmOptions {
  description?: string;
  hooks?: AgentHooks;
  instructions?: never;
  llm: Llm;
  model?: never;
  name?: string;
  sessions?: AgentSessionOptions;
  subagents?: never;
  toolChoice?: never;
  tools?: never;
}

export interface AgentSessionOptions {
  store?: SessionStore;
}

export interface SessionHandle {
  delete(): Promise<void>;
  interrupt(): void;
  kill(): void;
  send(input: AgentInput): Promise<AgentRun>;
  steer(input: AgentInput): Promise<AgentRun>;
}

export type AgentOptions = AgentLanguageModelOptions | AgentLlmOptions;
type AgentModelOptions = Pick<
  AgentLanguageModelOptions,
  "instructions" | "model" | "toolChoice"
>;

const subagentNamePattern = /^[a-z][a-z0-9_-]{0,51}$/;

export class Agent {
  readonly #baseTools?: ToolSet;
  readonly #hooks?: AgentHooks;
  readonly #llm?: Llm;
  readonly #modelOptions?: AgentModelOptions;
  readonly #childSessionCleanups = new Map<string, Set<() => Promise<void>>>();
  readonly #sessions = new Map<string, SessionHandle>();
  readonly #sessionNamespace = `agent:${crypto.randomUUID()}`;
  readonly #store: SessionStore;
  readonly #subagents: readonly Agent[];
  readonly description?: string;
  readonly name?: string;

  constructor(options: AgentOptions) {
    assertAgentOptions(options);

    this.description = options.description;
    this.name = options.name;
    this.#store = options.sessions?.store ?? new MemorySessionStore();
    this.#hooks = options.hooks;
    assertSubagents(options);
    this.#subagents = hasCustomLlm(options) ? [] : (options.subagents ?? []);
    if (hasCustomLlm(options)) {
      this.#llm = options.llm;
    } else {
      this.#baseTools = options.tools;
      this.#modelOptions = {
        instructions: options.instructions,
        model: options.model,
        toolChoice: options.toolChoice,
      };
    }
  }

  send(input: AgentInput): Promise<AgentRun> {
    return this.session("default").send(input);
  }

  session(key: string): SessionHandle {
    const existing = this.#sessions.get(key);
    if (existing) {
      return existing;
    }

    let session: AgentSession | undefined;
    const getSession = () => {
      if (!session) {
        throw new Error("Agent session is not initialized.");
      }
      return session;
    };
    const parentAgentNamespace = `${this.#sessionNamespace}:session:${crypto.randomUUID()}`;
    const llm =
      this.#llm ??
      createLlm(
        this.#createLlmOptionsForSession(
          key,
          parentAgentNamespace,
          (input: UserInput, placement?: "turn-start") =>
            getSession().enqueueRuntimeInput(input, placement),
          (event) => getSession().emitObserverEvent(event)
        )
      );
    session = new AgentSession(llm, { key, store: this.#store }, this.#hooks);
    const handle: SessionHandle = {
      delete: async () => {
        await session.delete();
        await this.#deleteChildSessions(key).finally(() =>
          this.#sessions.delete(key)
        );
      },
      interrupt: () => session.interrupt(),
      kill: () => {
        session.kill();
        this.#deleteChildSessions(key).catch(() => undefined);
        this.#sessions.delete(key);
      },
      send: (input) => session.send(input),
      steer: (input) => session.steer(input),
    };
    this.#sessions.set(key, handle);
    return handle;
  }

  #createLlmOptionsForSession(
    key: string,
    parentAgentNamespace: string,
    enqueueRuntimeInput: AgentSession["enqueueRuntimeInput"],
    emitObserverEvent: AgentSession["emitObserverEvent"]
  ): Parameters<typeof createLlm>[0] {
    const modelOptions = this.#modelOptions;
    if (!modelOptions) {
      throw new Error("Agent: missing model options.");
    }
    const tools =
      this.#subagents.length === 0
        ? this.#baseTools
        : {
            ...this.#baseTools,
            ...createSubagentTools({
              parentAgentNamespace,
              parentSession: { emitObserverEvent, enqueueRuntimeInput },
              parentSessionKey: key,
              registerChildSession: (sessionKey, cleanup) =>
                this.#registerChildSession(sessionKey, cleanup),
              subagents: this.#subagents,
            }),
          };

    return {
      instructions: modelOptions.instructions,
      model: modelOptions.model,
      toolChoice: modelOptions.toolChoice,
      tools,
    };
  }

  #registerChildSession(
    parentSessionKey: string,
    cleanup: () => Promise<void>
  ): void {
    const existing = this.#childSessionCleanups.get(parentSessionKey);
    if (existing) {
      existing.add(cleanup);
      return;
    }

    this.#childSessionCleanups.set(parentSessionKey, new Set([cleanup]));
  }

  async #deleteChildSessions(parentSessionKey: string): Promise<void> {
    const cleanups = this.#childSessionCleanups.get(parentSessionKey);
    if (!cleanups) {
      return;
    }

    await Promise.all([...cleanups].map((cleanup) => cleanup()));
    this.#childSessionCleanups.delete(parentSessionKey);
  }
}

function assertAgentOptions(options: unknown): asserts options is AgentOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      "Agent options are required. Provide either { model } or { llm }."
    );
  }

  const hasLlm = hasCustomLlm(options);
  const hasModel = "model" in options && options.model != null;

  if (hasLlm && hasModel) {
    throw new TypeError("Agent: provide either options.llm or options.model.");
  }

  if ("llm" in options && options.llm !== undefined && !hasLlm) {
    throw new TypeError("Agent: invalid options.llm.");
  }

  if (!(hasLlm || hasModel)) {
    throw new TypeError("Agent: missing options.model.");
  }
}

function assertSubagents(options: AgentOptions): void {
  if (!("subagents" in options) || options.subagents === undefined) {
    return;
  }

  if (hasCustomLlm(options)) {
    throw new TypeError("Agent: subagents require options.model.");
  }

  if (!Array.isArray(options.subagents)) {
    throw new TypeError("Agent: subagents must be an array.");
  }

  const toolNames = new Set(Object.keys(options.tools ?? {}));
  const generatedToolNames = new Set<string>();
  for (const [index, subagent] of options.subagents.entries()) {
    if (!(subagent instanceof Agent)) {
      throw new TypeError(`Agent: subagents[${index}] must be an Agent.`);
    }

    if (!isValidSubagentName(subagent.name)) {
      throw new TypeError(
        `Agent: subagents[${index}].name is required or too long.`
      );
    }

    if (!isNonEmptyText(subagent.description)) {
      throw new TypeError(
        `Agent: subagents[${index}].description is required.`
      );
    }

    const toolName = `delegate_to_${subagent.name.replaceAll("-", "_")}`;
    if (toolNames.has(toolName)) {
      throw new TypeError(
        `Agent: subagent tool ${toolName} collides with an existing tool.`
      );
    }

    if (generatedToolNames.has(toolName)) {
      throw new TypeError(`Agent: duplicate subagent tool name ${toolName}.`);
    }

    generatedToolNames.add(toolName);
  }

  for (const reservedToolName of ["background_output", "background_cancel"]) {
    if (toolNames.has(reservedToolName)) {
      throw new TypeError(
        `Agent: ${reservedToolName} collides with a reserved subagent tool.`
      );
    }
  }
}

function hasCustomLlm(options: object): options is AgentLlmOptions {
  return "llm" in options && typeof options.llm === "function";
}

function isNonEmptyText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidSubagentName(value: string | undefined): value is string {
  return typeof value === "string" && subagentNamePattern.test(value);
}
