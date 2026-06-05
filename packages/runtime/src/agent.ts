import type { LanguageModel, ToolSet } from "ai";
import { type AgentToolChoice, createLlm, type Llm } from "./llm";
import type { AgentPlugin } from "./plugins";
import {
  type ResolvedAgentPlugins,
  resolveAgentPlugins,
} from "./plugins/runner";
import type { AgentRun } from "./session/run";
import { type AgentInput, AgentSession } from "./session/session";
import { MemorySessionStore } from "./session/store/memory";
import type { SessionStore } from "./session/store/types";

interface AgentLanguageModelOptions {
  instructions?: string;
  llm?: never;
  model: LanguageModel;
  plugins?: readonly AgentPlugin[];
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

interface AgentLlmOptions {
  instructions?: never;
  llm: Llm;
  model?: never;
  plugins?: readonly AgentPlugin[];
  toolChoice?: never;
  tools?: never;
}

export interface SessionHandle {
  interrupt(): void;
  kill(): void;
  overlay(input: AgentInput): Promise<AgentRun>;
  send(input: AgentInput): Promise<AgentRun>;
  steer(input: AgentInput): Promise<AgentRun>;
}

export type AgentOptions = AgentLanguageModelOptions | AgentLlmOptions;

export class Agent {
  readonly #internalLlm: Llm;
  readonly #llm: Llm;
  readonly #plugins: ResolvedAgentPlugins;
  readonly #sessions = new Map<string, SessionHandle>();
  readonly #store: SessionStore;

  private constructor(
    options: AgentOptions,
    resolvedPlugins: ResolvedAgentPlugins
  ) {
    assertAgentOptions(options);

    this.#plugins = resolvedPlugins;
    this.#store =
      resolvedPlugins.sessionStore?.store ?? new MemorySessionStore();
    if (hasCustomLlm(options)) {
      this.#internalLlm = options.llm;
      this.#llm = options.llm;
    } else {
      this.#internalLlm = createLlm({
        instructions: options.instructions,
        model: options.model,
      });
      this.#llm = createLlm({
        instructions: options.instructions,
        model: options.model,
        toolChoice: options.toolChoice,
        tools: resolvedPlugins.tools,
      });
    }
  }

  static async create(options: AgentOptions): Promise<Agent> {
    assertAgentOptions(options);
    const resolvedPlugins = await resolveAgentPlugins({
      callerTools: hasCustomLlm(options) ? undefined : options.tools,
      plugins: options.plugins,
    });
    return new Agent(options, resolvedPlugins);
  }

  send(input: AgentInput): Promise<AgentRun> {
    return this.session("default").send(input);
  }

  session(key: string): SessionHandle {
    const existing = this.#sessions.get(key);
    if (existing) {
      return existing;
    }

    const session = new AgentSession(
      this.#llm,
      { key, store: this.#store },
      this.#plugins,
      this.#internalLlm
    );
    const handle: SessionHandle = {
      interrupt: () => session.interrupt(),
      kill: () => {
        session.kill();
        this.#sessions.delete(key);
      },
      overlay: (input) => session.overlay(input),
      send: (input) => session.send(input),
      steer: (input) => session.steer(input),
    };
    this.#sessions.set(key, handle);
    return handle;
  }
}

function assertAgentOptions(options: unknown): asserts options is AgentOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      "Agent options are required. Provide either { model } or { llm }."
    );
  }

  if ("sessions" in options) {
    throw new TypeError(
      "Agent.create: options.sessions was removed. Use plugins: [sessions.custom(store)]."
    );
  }

  if ("hooks" in options) {
    throw new TypeError(
      "Agent.create: options.hooks was removed. Use run.events() with session.steer() for app control or plugin lifecycle handlers for middleware."
    );
  }

  const hasLlm = hasCustomLlm(options);
  const hasModel =
    "model" in options && options.model !== undefined && options.model !== null;

  if (hasLlm && hasModel) {
    throw new TypeError(
      "Agent.create: provide either options.llm or options.model, not both."
    );
  }

  if ("llm" in options && options.llm !== undefined && !hasLlm) {
    throw new TypeError("Agent.create: invalid options.llm.");
  }

  if (!(hasLlm || hasModel)) {
    throw new TypeError("Agent.create: missing options.model.");
  }
}

function hasCustomLlm(options: object): options is AgentLlmOptions {
  return "llm" in options && typeof options.llm === "function";
}
