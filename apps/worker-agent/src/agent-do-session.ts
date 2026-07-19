import type { Agent, ThreadHandle } from "@minpeter/pss-runtime";
import type { CloudflarePlatformContext } from "@minpeter/pss-runtime/platform/cloudflare";

import { createConfiguredAgent } from "./agent";
import { createLongLivedSendMessageOptions } from "./agent-do-message";
import { createTurnSession, type TurnSession } from "./agent-do-turn-session";
import {
  type AgentDoState,
  AgentDurableObjectInvariantError,
  SESSION_BINDING_STORAGE_KEY,
  type SessionBindingRecord,
} from "./agent-do-types";
import {
  type ChannelRuntimeBinding,
  durableObjectChannelBinding,
} from "./channel";
import type { Env } from "./env";
import {
  createSessionIndexStore,
  type SessionIndexStore,
} from "./session-index";
import type { SessionIndexClient } from "./session-index-client";
import { createSqlSessionIndexRepository } from "./session-index-sql";
import type { SessionTranscriptReader } from "./session-transcript";

export interface AgentDoSessionOptions {
  readonly env: Env;
  readonly platform: CloudflarePlatformContext<Agent>;
  readonly sessionIndexClient: SessionIndexClient;
  readonly sessionTranscriptClient: SessionTranscriptReader;
  readonly state: AgentDoState;
  readonly storage: DurableObjectStorage;
}

export class AgentDoSession {
  readonly #env: Env;
  readonly #platform: CloudflarePlatformContext<Agent>;
  readonly #sessionIndexClient: SessionIndexClient;
  readonly #sessionTranscriptClient: SessionTranscriptReader;
  readonly #state: AgentDoState;
  readonly #storage: DurableObjectStorage;
  #sessionIndexStore: SessionIndexStore | undefined;
  #turnSession: TurnSession | undefined;
  #turnSessionPromise: Promise<TurnSession> | undefined;
  #runtimeThread: ThreadHandle | undefined;

  constructor(options: AgentDoSessionOptions) {
    this.#env = options.env;
    this.#platform = options.platform;
    this.#sessionIndexClient = options.sessionIndexClient;
    this.#sessionTranscriptClient = options.sessionTranscriptClient;
    this.#state = options.state;
    this.#storage = options.storage;
  }

  async restoreBinding(): Promise<void> {
    const stored = await this.#storage.get<SessionBindingRecord>(
      SESSION_BINDING_STORAGE_KEY
    );
    if (!stored) {
      return;
    }
    this.#state.channel = stored.channel;
    this.#state.sessionScopeKey = stored.sessionScopeKey;
  }

  runtimeThread(): ThreadHandle | undefined {
    return this.#runtimeThread;
  }

  sessionIndex(): SessionIndexStore {
    if (!this.#sessionIndexStore) {
      const sql = this.#storage.sql;
      if (!sql) {
        throw new AgentDurableObjectInvariantError(
          "Session index requires a SQLite-backed Durable Object."
        );
      }
      this.#sessionIndexStore = createSessionIndexStore(
        createSqlSessionIndexRepository(sql)
      );
    }
    return this.#sessionIndexStore;
  }

  async ensureTurnSession(
    binding: ChannelRuntimeBinding
  ): Promise<TurnSession> {
    if (this.#turnSession) {
      return this.#turnSession;
    }
    if (this.#turnSessionPromise) {
      return await this.#turnSessionPromise;
    }

    const initializing = (async () => {
      const agent = await createConfiguredAgent(
        this.#env,
        this.#platform.host(),
        {
          sendMessage: createLongLivedSendMessageOptions(
            this.#env,
            this.#state
          ),
          sessionTools: {
            currentConversationKey: () => {
              const channel = this.#state.channel;
              if (!channel) {
                return binding.channelKey;
              }
              return durableObjectChannelBinding(channel).channelKey;
            },
            currentSessionScopeKey: () => this.#state.sessionScopeKey,
            reader: this.#sessionIndexClient,
            transcriptReader: this.#sessionTranscriptClient,
          },
          observability: {
            log: (entry) => {
              this.#state.observability?.record(entry);
            },
          },
        }
      );
      try {
        const thread = agent.thread(binding.thread);
        const session = createTurnSession(thread);
        this.#runtimeThread = thread;
        this.#turnSession = session;
        return session;
      } catch (error) {
        await agent.dispose().catch(() => undefined);
        throw error;
      }
    })();
    this.#turnSessionPromise = initializing;
    try {
      return await initializing;
    } catch (error) {
      if (this.#turnSessionPromise === initializing) {
        this.#turnSessionPromise = undefined;
      }
      throw error;
    }
  }
}
