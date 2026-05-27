import type { LanguageModel, ToolSet } from "ai";
import type { AgentHooks } from "./hooks";
import {
  type AgentToolChoice,
  createLlm,
  type Llm,
} from "./llm";
import type { AgentRun } from "./session/run";
import { type AgentInput, AgentSession } from "./session/session";
import { MemorySessionStore } from "./session/store/memory";
import type { SessionStore } from "./session/store/types";

interface AgentModelOptions {
  hooks?: AgentHooks;
  instructions?: string;
  llm?: never;
  model: LanguageModel;
  sessions?: AgentSessionOptions;
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

interface AgentLlmOptions {
  hooks?: AgentHooks;
  instructions?: never;
  llm: Llm;
  model?: never;
  sessions?: AgentSessionOptions;
  toolChoice?: never;
  tools?: never;
}

export interface AgentSessionOptions {
  store?: SessionStore;
}

export interface SessionHandle {
  interrupt(): void;
  kill(): void;
  send(input: AgentInput): Promise<AgentRun>;
  steer(input: AgentInput): Promise<AgentRun>;
}

export type AgentOptions = AgentModelOptions | AgentLlmOptions;

export class Agent {
  readonly #hooks?: AgentHooks;
  readonly #llm: Llm;
  readonly #sessions = new Map<string, SessionHandle>();
  readonly #store: SessionStore;

  private constructor(options: AgentOptions) {
    assertAgentOptions(options);

    this.#store = options.sessions?.store ?? new MemorySessionStore();
    this.#hooks = options.hooks;
    this.#llm = hasCustomLlm(options)
      ? options.llm
      : createLlm({
          instructions: options.instructions,
          model: options.model,
          toolChoice: options.toolChoice,
          tools: options.tools,
        });
  }

  static create(options: AgentOptions): Promise<Agent> {
    return Promise.resolve().then(() => new Agent(options));
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
      this.#hooks
    );
    const handle: SessionHandle = {
      interrupt: () => session.interrupt(),
      kill: () => {
        session.kill();
        this.#sessions.delete(key);
      },
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
