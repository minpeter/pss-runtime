import type { Agent as PssAgent } from "@minpeter/pss-runtime";
import {
  type CloudflareAgentsFiberRecoveryContext,
  type CloudflareAgentsFiberRecoveryResult,
  type CloudflarePlatformContext,
  createCloudflarePlatformContext,
} from "@minpeter/pss-runtime/platform/cloudflare";
import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/cloudflare/image-codecs";
import { Agent as CloudflareAgent } from "agents";

import { createConfiguredAgent } from "./agent";
import { deliverToolOnlyTurn, withCapturedMessages } from "./agent-do-delivery";
import { parseAgentRequest } from "./agent-do-request";
import {
  createRequestSendMessageToolSetup,
  createSendMessageToolOptions,
  type SendMessageToolSetup,
} from "./agent-do-send-message";
import { agentInputFromRequest, agentTurnIndexText } from "./agent-input";
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
  type SessionIndexClient,
} from "./session-index-client";
import { handleSessionIndexRequest } from "./session-index-routes";
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
import {
  attachmentLogFields,
  createTurnLogger,
  ensureWorkerLogger,
  logError,
} from "./worker-log";

// DO isolate may load this module without executing worker entry side-effects.
// Install static AVIF/WebP/HEIF wasm so attachment staging never hits
// "wasm not installed" on the Durable Object path.
installCloudflareImageCodecs();
ensureWorkerLogger();

/**
 * Channel agent Durable Object implemented on the Cloudflare Agents SDK.
 * Scheduling/resume uses Agents fibers; HTTP remains app-owned via onRequest.
 */
export class AgentDurableObject extends CloudflareAgent<Env> {
  readonly #platform: CloudflarePlatformContext<PssAgent>;
  readonly #env: Env;
  readonly #storage: DurableObjectStorage;
  readonly #sessionIndexClient: SessionIndexClient;
  readonly #sessionTranscriptClient: SessionTranscriptReader;
  #sessionIndexStore: SessionIndexStore | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#env = env;
    this.#storage = ctx.storage;
    this.#sessionIndexClient = createSessionIndexClient(env);
    this.#sessionTranscriptClient = createSessionTranscriptClient(env);
    this.#platform = createCloudflarePlatformContext({
      cloudflareAgent: this,
      createAgent: ({ env: agentEnv, host }) =>
        createConfiguredAgent(agentEnv, host, {
          sendMessage: createSendMessageToolOptions(agentEnv, () => undefined),
        }),
      durableObjectContext: this.ctx,
      env,
    });
  }

  /** Agents scheduler callback for delayed PSS run/thread resumes. */
  async resumePssRuntimeFiber(payload: unknown): Promise<void> {
    await this.#platform.resumeScheduledFiber(payload);
  }

  override async onFiberRecovered(
    ctx: CloudflareAgentsFiberRecoveryContext
  ): Promise<undefined | CloudflareAgentsFiberRecoveryResult> {
    const result = await this.#platform.recoverFiber(ctx);
    if (result === false) {
      return;
    }
    return result;
  }

  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const pathname = new URL(request.url).pathname;
    if (isSessionIndexPath(pathname)) {
      return await handleSessionIndexRequest({
        pathname,
        request,
        store: this.#sessionIndex(),
      });
    }
    if (isSessionTranscriptPath(pathname)) {
      return await this.#handleSessionTranscriptRequest(request);
    }

    const log = createTurnLogger(request);
    const payload = await parseAgentRequest(request);
    if (!payload) {
      log.set({ action: "agent_turn", outcome: "invalid_payload" });
      log.emit({ status: 400 });
      return new Response("text or attachments and channel required", {
        status: 400,
      });
    }

    const attachmentFields = attachmentLogFields(payload.attachments);
    log.set({
      action: "agent_turn",
      channelKind: payload.channel.kind,
      hasSessionScope: Boolean(payload.sessionScopeKey),
      textChars: payload.text.length,
      ...attachmentFields,
    });

    try {
      const sendMessage = createRequestSendMessageToolSetup(
        this.#env,
        payload.channel
      );
      const binding = durableObjectChannelBinding(payload.channel);
      const sessionScopeKey = payload.sessionScopeKey;
      const agent = createConfiguredAgent(this.#env, this.#platform.host(), {
        sendMessage: sendMessage.options,
        sessionTools: {
          currentConversationKey: () => binding.channelKey,
          currentSessionScopeKey: () => sessionScopeKey,
          reader: this.#sessionIndexClient,
          transcriptReader: this.#sessionTranscriptClient,
        },
      });
      const assistantMessages: string[] = [];
      const delivery = await deliverToolOnlyTurn(
        agent.thread(binding.thread),
        agentInputFromRequest(payload),
        { onAssistantOutput: (text) => assistantMessages.push(text) }
      );
      await this.#indexTurn(
        binding,
        agentTurnIndexText(payload),
        sendMessage,
        assistantMessages,
        sessionScopeKey
      );

      log.set({
        delivered: delivery.delivered,
        outcome: delivery.delivered ? "delivered" : "missing_send_message",
        ...(delivery.delivered
          ? {}
          : { deliveryError: "missing_send_message" }),
      });
      log.emit({ status: 200 });
      return Response.json(
        withCapturedMessages(delivery, sendMessage.messages())
      );
    } catch (error) {
      log.error(error instanceof Error ? error : new Error(String(error)));
      log.set({ outcome: "error" });
      log.emit({ status: 500 });
      throw error;
    }
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
    assistantMessages: readonly string[],
    sessionScopeKey: string | undefined
  ): Promise<void> {
    const delivered = sendMessage.messages().map((message) => message.text);
    const assistantText = delivered.length > 0 ? delivered : assistantMessages;
    try {
      await this.#sessionIndexClient.upsert({
        assistantText,
        channel: binding.channel,
        ...(sessionScopeKey ? { sessionScopeKey } : {}),
        threadKey: binding.threadKey,
        userText,
      });
    } catch (error) {
      logError(normalizeIndexError(error), {
        action: "session_index_upsert_failed",
        scope: "agent-do",
      });
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
