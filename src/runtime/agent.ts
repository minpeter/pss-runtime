import { mockLlm, type Llm } from "./mock-llm";
import {
  AgentSession,
  type SessionHistoryStore,
  type SessionSnapshot,
} from "./session";

type AgentOptions = {
  llm?: Llm;
  historyStore?: SessionHistoryStore;
};

type CreateSessionOptions = {
  // Persisted sessions need a caller-owned stable id, e.g. a DB row, chat room, or file key.
  id?: string;
  snapshot?: SessionSnapshot;
  historyStore?: SessionHistoryStore;
};

export class Agent {
  readonly #llm: Llm;
  readonly #historyStore?: SessionHistoryStore;

  constructor(options: AgentOptions = {}) {
    this.#llm = options.llm ?? mockLlm;
    this.#historyStore = options.historyStore;
  }

  createSession(options: CreateSessionOptions = {}): AgentSession {
    return new AgentSession({
      id: options.id ?? options.snapshot?.sessionId ?? crypto.randomUUID(),
      llm: this.#llm,
      snapshot: options.snapshot,
      historyStore: options.historyStore ?? this.#historyStore,
    });
  }
}
