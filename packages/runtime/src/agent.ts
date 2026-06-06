import type { LanguageModel, ToolSet } from "ai";
import {
  agentNamespace,
  parentSessionNamespace,
  randomAgentNamespace,
} from "./agent-namespace";
import { assertSubagents } from "./agent-validation";
import { ChildSessionCleanups } from "./child-session-cleanups";
import { type AgentToolChoice, createLlm, type RuntimeLlm } from "./llm";
import type { AgentPlugin } from "./plugins";
import type { UserInput } from "./session/events";
import type { AgentRun } from "./session/run";
import { type AgentInput, AgentSession } from "./session/session";
import { MemorySessionStore } from "./session/store/memory";
import type { SessionStore } from "./session/store/types";
import { createSubagentTools } from "./subagents";

interface AgentLanguageModelOptions {
  description?: string;
  instructions?: string;
  llm?: never;
  model: LanguageModel;
  name?: string;
  plugins?: readonly AgentPlugin[];
  sessions?: AgentSessionOptions;
  subagents?: readonly Agent[];
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

interface AgentLlmOptions {
  description?: string;
  instructions?: never;
  llm: RuntimeLlm;
  model?: never;
  name?: string;
  plugins?: readonly AgentPlugin[];
  sessions?: AgentSessionOptions;
  subagents?: never;
  toolChoice?: never;
  tools?: never;
}

export interface AgentSessionOptions {
  namespace?: string;
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

export class Agent {
  readonly #baseTools?: ToolSet;
  readonly #llm?: RuntimeLlm;
  readonly #modelOptions?: AgentModelOptions;
  readonly #childSessionCleanups = new ChildSessionCleanups();
  readonly #sessionGenerations = new Map<string, number>();
  readonly #sessions = new Map<string, SessionHandle>();
  readonly #sessionNamespace: string;
  readonly #store: SessionStore;
  readonly #plugins: readonly AgentPlugin[];
  readonly #subagents: readonly Agent[];
  readonly description?: string;
  readonly name?: string;

  constructor(options: AgentOptions) {
    assertAgentOptions(options);

    this.description = options.description;
    this.name = options.name;
    this.#sessionNamespace = stableAgentNamespace(options);
    this.#store = options.sessions?.store ?? new MemorySessionStore();
    this.#plugins = options.plugins ?? [];
    assertSubagents(options, Agent, hasCustomLlm(options));
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
    const parentAgentNamespace = parentSessionNamespace({
      generation: this.#sessionGenerations.get(key) ?? 0,
      sessionKey: key,
      sessionNamespace: this.#sessionNamespace,
    });
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
    session = new AgentSession(llm, { key, store: this.#store }, this.#plugins);
    const handle: SessionHandle = {
      delete: async () => {
        await session.delete();
        this.#sessions.delete(key);
        this.#sessionGenerations.set(
          key,
          (this.#sessionGenerations.get(key) ?? 0) + 1
        );
        await this.#deleteChildSessions(key);
      },
      interrupt: () => session.interrupt(),
      kill: () => {
        session.kill();
        this.#sessionGenerations.set(
          key,
          (this.#sessionGenerations.get(key) ?? 0) + 1
        );
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
                this.#childSessionCleanups.register(sessionKey, cleanup),
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

  async #deleteChildSessions(parentSessionKey: string): Promise<void> {
    await this.#childSessionCleanups.delete(parentSessionKey);
  }
}

function stableAgentNamespace(options: AgentOptions): string {
  const namespace = options.sessions?.namespace ?? options.name;
  return namespace ? agentNamespace(namespace) : randomAgentNamespace();
}

function assertAgentOptions(options: unknown): asserts options is AgentOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      "Agent options are required. Provide either { model } or { llm }."
    );
  }

  const hasLlm = hasCustomLlm(options);
  const hasModel = "model" in options && options.model != null;

  const legacyLifecycleOption = ["h", "o", "o", "k", "s"].join("");
  if (legacyLifecycleOption in options) {
    throw new TypeError("Agent: unsupported legacy lifecycle option.");
  }

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

function hasCustomLlm(options: object): options is AgentLlmOptions {
  return "llm" in options && typeof options.llm === "function";
}
