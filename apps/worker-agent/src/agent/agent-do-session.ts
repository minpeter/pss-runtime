import type { Agent, ThreadHandle } from "@minpeter/pss-runtime";
import { dispatchAgentNotification } from "@minpeter/pss-runtime/execution";
import type { CloudflarePlatformContext } from "@minpeter/pss-runtime/platform/cloudflare";
import {
  CHANNEL_DURABLE_OBJECT_THREAD_KEY,
  type ChannelAddress,
  type ChannelRuntimeBinding,
  durableObjectChannelBinding,
} from "../channel";
import type { Env } from "../env";
import {
  parseSessionChannel,
  parseThreadEventCursor,
  ReplayEventsRequestSchema,
  SubmitTurnRequestSchema,
  type ThreadEventCursor,
} from "../session/session-contract";
import { createSessionEventStreamResponse } from "../session/session-events";
import { replayDurableThreadEvents } from "../session/session-runtime";
import {
  createThreadStoreSessionTranscriptReader,
  type SessionTranscriptReader,
} from "../session/session-transcript";
import { SessionTranscriptReadRequestSchema } from "../session/session-transcript-client";
import {
  createSessionIndexStore,
  type SessionIndexStore,
} from "../session-index/session-index";
import type { SessionIndexClient } from "../session-index/session-index-client";
import { createSqlSessionIndexRepository } from "../session-index/session-index-sql";
import type { WorkerAgentSendMessageToolOptions } from "../tools";
import { createConfiguredAgent, WORKER_AGENT_NAMESPACE } from "./agent";
import { createTurnSession, type TurnSession } from "./agent-do-turn-session";
import {
  type AgentDoState,
  AgentDurableObjectInvariantError,
  requireRuntimeThread,
  SESSION_BINDING_STORAGE_KEY,
  type SessionBindingRecord,
} from "./agent-do-types";

export interface AgentDoSessionOptions {
  readonly createSendMessage: () => WorkerAgentSendMessageToolOptions;
  readonly env: Env;
  readonly platform: CloudflarePlatformContext<Agent>;
  readonly sessionIndexClient: SessionIndexClient;
  readonly sessionTranscriptClient: SessionTranscriptReader;
  readonly state: AgentDoState;
  readonly storage: DurableObjectStorage;
}

export class AgentDoSession {
  readonly #createSendMessage: () => WorkerAgentSendMessageToolOptions;
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
    this.#createSendMessage = options.createSendMessage;
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
          sendMessage: this.#createSendMessage(),
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

  async handleEventStream(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const serializedChannel = url.searchParams.get("channel");
    if (!serializedChannel) {
      return new Response("channel required", { status: 400 });
    }

    let channel: ChannelAddress;
    let after: ThreadEventCursor | undefined;
    try {
      channel = parseSessionChannel(serializedChannel);
      const serializedAfter = url.searchParams.get("after");
      after =
        serializedAfter === null
          ? undefined
          : parseThreadEventCursor(serializedAfter);
    } catch {
      return new Response("invalid session event stream", { status: 400 });
    }
    this.#state.channel = channel;
    this.#state.sessionScopeKey =
      url.searchParams.get("sessionScopeKey")?.trim() || undefined;
    await this.ensureTurnSession(durableObjectChannelBinding(channel));
    const thread = requireRuntimeThread(this.runtimeThread());

    return createSessionEventStreamResponse({
      ...(after ? { after } : {}),
      live: this.#state.sessionEventLive,
      replay: (cursor) =>
        replayDurableThreadEvents(thread, {
          ...(cursor ? { after: cursor } : {}),
          limit: 100,
        }),
    });
  }

  async handleSubmit(body: unknown): Promise<Response> {
    const parsed = SubmitTurnRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid session turn", { status: 400 });
    }

    const channelId = parsed.data.channel.id.trim();
    const text = parsed.data.text.trim();
    if (!(channelId && text)) {
      return new Response("invalid session turn", { status: 400 });
    }
    const channel = { id: channelId, kind: parsed.data.channel.kind };
    const sessionScopeKey = parsed.data.sessionScopeKey?.trim();
    this.#state.channel = channel;
    this.#state.sessionScopeKey = sessionScopeKey || undefined;
    await this.#storage.put(SESSION_BINDING_STORAGE_KEY, {
      channel,
      ...(sessionScopeKey ? { sessionScopeKey } : {}),
    } satisfies SessionBindingRecord);

    const admitted = await dispatchAgentNotification({
      host: this.#platform.host(),
      idempotencyKey: parsed.data.idempotencyKey?.trim() || crypto.randomUUID(),
      input: { text, type: "user-input" },
      namespace: WORKER_AGENT_NAMESPACE,
      threadKey: CHANNEL_DURABLE_OBJECT_THREAD_KEY,
    });
    return Response.json({
      accepted: true,
      runId: admitted.runId,
      threadKey: CHANNEL_DURABLE_OBJECT_THREAD_KEY,
    });
  }

  async handleReplay(body: unknown): Promise<Response> {
    const parsed = ReplayEventsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid session replay", { status: 400 });
    }

    const channelId = parsed.data.channel.id.trim();
    if (!channelId) {
      return new Response("invalid session replay", { status: 400 });
    }
    const channel = { id: channelId, kind: parsed.data.channel.kind };
    this.#state.channel = channel;
    this.#state.sessionScopeKey =
      parsed.data.sessionScopeKey?.trim() || undefined;
    await this.ensureTurnSession(durableObjectChannelBinding(channel));
    const thread = requireRuntimeThread(this.runtimeThread());

    return Response.json(
      await replayDurableThreadEvents(thread, {
        ...(parsed.data.after ? { after: parsed.data.after } : {}),
        ...(parsed.data.limit === undefined
          ? {}
          : { limit: parsed.data.limit }),
      })
    );
  }

  async handleTranscript(body: unknown): Promise<Response> {
    if (body === undefined) {
      return new Response("invalid json", { status: 400 });
    }

    const parsed = SessionTranscriptReadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid transcript read", { status: 400 });
    }

    const transcript = await createThreadStoreSessionTranscriptReader({
      resolveThreadKey: () => CHANNEL_DURABLE_OBJECT_THREAD_KEY,
      store: this.#platform.host().store.threads,
    }).read(parsed.data.conversationKey, {
      ...(parsed.data.before === undefined
        ? {}
        : { before: parsed.data.before }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });

    return Response.json(
      transcript
        ? { ...transcript, found: true }
        : { conversationKey: parsed.data.conversationKey, found: false }
    );
  }
}
