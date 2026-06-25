import { DurableObject } from "cloudflare:workers";
import type { Agent } from "@minpeter/pss-runtime";
import {
  type CloudflareAgentContext,
  createCloudflareAgentContext,
} from "@minpeter/pss-runtime/cloudflare";

import { createConfiguredAgent } from "./agent";
import { deliverToolOnlyTurn, withCapturedMessages } from "./agent-do-delivery";
import { parseAgentRequest } from "./agent-do-request";
import {
  createRequestSendMessageToolSetup,
  createSendMessageToolOptions,
  type SendMessageToolSetup,
} from "./agent-do-send-message";
import {
  CHANNEL_DURABLE_OBJECT_THREAD_KEY,
  type ChannelRuntimeBinding,
  durableObjectChannelBinding,
} from "./channel";
import type { Env } from "./env";
import {
  createSessionIndexStore,
  type SessionIndexStore,
} from "./session-index";
import {
  createSessionIndexClient,
  isSessionIndexPath,
  SESSION_INDEX_LIST_PATH,
  SESSION_INDEX_SEARCH_PATH,
  SESSION_INDEX_UPSERT_PATH,
  type SessionIndexClient,
  SessionIndexListRequestSchema,
  SessionIndexSearchRequestSchema,
  SessionIndexUpsertRequestSchema,
} from "./session-index-client";
import { createSqlSessionIndexRepository } from "./session-index-sql";
import {
  createThreadStoreSessionTranscriptReader,
  type SessionTranscriptReader,
} from "./session-transcript";
import {
  createSessionTranscriptClient,
  isSessionTranscriptPath,
  SessionTranscriptReadRequestSchema,
} from "./session-transcript-client";

export class AgentDurableObject extends DurableObject<Env> {
  readonly #context: CloudflareAgentContext<Agent>;
  readonly #env: Env;
  readonly #storage: DurableObjectStorage;
  readonly #sessionIndexClient: SessionIndexClient;
  readonly #sessionTranscriptClient: SessionTranscriptReader;
  #sessionIndexStore: SessionIndexStore | undefined;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#env = env;
    this.#storage = state.storage;
    this.#sessionIndexClient = createSessionIndexClient(env);
    this.#sessionTranscriptClient = createSessionTranscriptClient(env);
    this.#context = createCloudflareAgentContext({
      createAgent: ({ env: agentEnv, host }) =>
        createConfiguredAgent(agentEnv, host, {
          sendMessage: createSendMessageToolOptions(agentEnv, () => undefined),
        }),
      env,
      storage: state.storage,
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const pathname = new URL(request.url).pathname;
    if (isSessionIndexPath(pathname)) {
      return await this.#handleSessionIndexRequest(pathname, request);
    }
    if (isSessionTranscriptPath(pathname)) {
      return await this.#handleSessionTranscriptRequest(request);
    }

    const payload = await parseAgentRequest(request);
    if (!payload) {
      return new Response("text and channel required", { status: 400 });
    }

    const sendMessage = createRequestSendMessageToolSetup(
      this.#env,
      payload.channel
    );
    const binding = durableObjectChannelBinding(payload.channel);
    const agent = createConfiguredAgent(this.#env, this.#context.host(), {
      sendMessage: sendMessage.options,
      sessionTools: {
        currentConversationKey: () => binding.channelKey,
        reader: this.#sessionIndexClient,
        transcriptReader: this.#sessionTranscriptClient,
      },
    });
    const assistantMessages: string[] = [];
    const delivery = await deliverToolOnlyTurn(
      agent.thread(binding.thread),
      payload.text,
      { onAssistantOutput: (text) => assistantMessages.push(text) }
    );
    await this.#indexTurn(
      binding,
      payload.text,
      sendMessage,
      assistantMessages
    );

    return Response.json(
      withCapturedMessages(delivery, sendMessage.messages())
    );
  }

  async alarm(): Promise<void> {
    await this.#context.drainAlarm();
  }

  async #handleSessionIndexRequest(
    pathname: string,
    request: Request
  ): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    const store = this.#sessionIndex();
    if (pathname === SESSION_INDEX_UPSERT_PATH) {
      const parsed = SessionIndexUpsertRequestSchema.safeParse(body);
      if (!parsed.success) {
        return new Response("invalid upsert", { status: 400 });
      }
      await store.upsert({
        assistantText: parsed.data.assistantText ?? [],
        channel: parsed.data.channel,
        threadKey: parsed.data.threadKey,
        userText: parsed.data.userText,
      });
      return Response.json({ ok: true });
    }
    if (pathname === SESSION_INDEX_LIST_PATH) {
      const parsed = SessionIndexListRequestSchema.safeParse(body);
      if (!parsed.success) {
        return new Response("invalid list", { status: 400 });
      }
      const sessions = await store.list({
        ...(parsed.data.excludeKey
          ? { excludeKey: parsed.data.excludeKey }
          : {}),
        ...(parsed.data.limit === undefined
          ? {}
          : { limit: parsed.data.limit }),
      });
      return Response.json({ sessions });
    }
    if (pathname === SESSION_INDEX_SEARCH_PATH) {
      const parsed = SessionIndexSearchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return new Response("invalid search", { status: 400 });
      }
      const sessions = await store.search(parsed.data.query, {
        ...(parsed.data.excludeKey
          ? { excludeKey: parsed.data.excludeKey }
          : {}),
        ...(parsed.data.limit === undefined
          ? {}
          : { limit: parsed.data.limit }),
      });
      return Response.json({ sessions });
    }
    return new Response("not found", { status: 404 });
  }

  async #handleSessionTranscriptRequest(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    const parsed = SessionTranscriptReadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid transcript read", { status: 400 });
    }

    const transcript = await createThreadStoreSessionTranscriptReader({
      resolveThreadKey: () => CHANNEL_DURABLE_OBJECT_THREAD_KEY,
      store: this.#context.host().store.threads,
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

  #sessionIndex(): SessionIndexStore {
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

  async #indexTurn(
    binding: ChannelRuntimeBinding,
    userText: string,
    sendMessage: SendMessageToolSetup,
    assistantMessages: readonly string[]
  ): Promise<void> {
    const delivered = sendMessage.messages().map((message) => message.text);
    const assistantText = delivered.length > 0 ? delivered : assistantMessages;
    try {
      await this.#sessionIndexClient.upsert({
        assistantText,
        channel: binding.channel,
        threadKey: binding.threadKey,
        userText,
      });
    } catch (error) {
      console.error("session index upsert failed", normalizeIndexError(error));
    }
  }
}

class AgentDurableObjectInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDurableObjectInvariantError";
  }
}

function normalizeIndexError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new AgentDurableObjectInvariantError(
        `Non-Error thrown: ${String(error)}`
      );
}
