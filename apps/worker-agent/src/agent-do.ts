import type {
  Agent,
  AgentInput,
  ImageOmitDiagnostics,
  ImagePrepareDiagnostics,
  Agent as PssAgent,
} from "@minpeter/pss-runtime";
import {
  IMAGE_PREPARE_LOG_MESSAGE,
  runWithImageOmitDiagnosticsListener,
  runWithImagePrepareDiagnosticsListener,
} from "@minpeter/pss-runtime";
import {
  type CloudflareAgentsFiberRecoveryContext,
  type CloudflareAgentsFiberRecoveryResult,
  type CloudflarePlatformContext,
  createCloudflarePlatformContext,
} from "@minpeter/pss-runtime/platform/cloudflare";
import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/cloudflare/image-codecs";
import { Agent as CloudflareAgent } from "agents";

import { createConfiguredAgent, DEFAULT_MODEL } from "./agent";
import {
  type WorkerAgentDeliveredMessage,
  withCapturedMessages,
} from "./agent-do-delivery";
import { parseAgentRequest } from "./agent-do-request";
import {
  createRequestSendMessageToolSetup,
  createSendMessageToolOptions,
  type SendMessageToolSetup,
} from "./agent-do-send-message";
import { createTurnSession, type TurnSession } from "./agent-do-turn-session";
import {
  agentInputFromRequest,
  agentTurnIndexText,
  InvalidAttachmentBase64Error,
} from "./agent-input";
import {
  CHANNEL_DURABLE_OBJECT_THREAD_KEY,
  type ChannelAddress,
  type ChannelRuntimeBinding,
  durableObjectChannelBinding,
} from "./channel";
import type { Env } from "./env";
import { AGENT_TURN_ADMISSION_LAYER } from "./message-path-layers";
import { createTurnEventCollector } from "./observability";
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
import type { WorkerAgentSendMessageToolOptions } from "./tools";
import { workerErrors } from "./worker-errors";
import {
  attachmentLogFields,
  createTurnLogger,
  ensureWorkerLogger,
  imagePrepareLogEvent,
  logError,
  logInfo,
  logWarn,
  summarizeImageOmits,
  summarizeImagePrepares,
} from "./worker-log";

// DO isolate may load this module without worker-entry side-effects.
installCloudflareImageCodecs();

/**
 * Channel agent Durable Object on the Cloudflare Agents SDK.
 * Scheduling/resume uses Agents fibers; HTTP remains app-owned via onRequest.
 *
 * Layer 2 — agent turn admission (`AGENT_TURN_ADMISSION_LAYER`):
 * reuses one Agent/ThreadHandle per DO so every user message is delivered
 * immediately — idle → send, running → mid-turn steer.
 *
 * Layer 1 Telegram fragment reassembly (quiet window) lives only in
 * telegram.ts / telegram-message-coalesce.ts and never inside this DO.
 */
export class AgentDurableObject extends CloudflareAgent<Env> {
  readonly #platform: CloudflarePlatformContext<PssAgent>;
  readonly #env: Env;
  readonly #storage: DurableObjectStorage;
  readonly #sessionIndexClient: SessionIndexClient;
  readonly #sessionTranscriptClient: SessionTranscriptReader;
  #sessionIndexStore: SessionIndexStore | undefined;
  /** Layer 2: reused so send/steer share in-memory active-run state. */
  #agent: Agent | undefined;
  #turnSession: TurnSession | undefined;
  #channel: ChannelAddress | undefined;
  #sessionScopeKey: string | undefined;
  #observability: ReturnType<typeof createTurnEventCollector> | undefined;
  #tuiMessageCapture: WorkerAgentDeliveredMessage[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#env = env;
    this.#storage = ctx.storage;
    ensureWorkerLogger({
      environment: env.ENVIRONMENT,
      version: env.CF_VERSION_METADATA?.id,
    });
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
      const invalid = workerErrors.INVALID_TURN_PAYLOAD();
      log.error(invalid);
      log.set({
        action: "agent_turn",
        outcome: "invalid_payload",
      });
      log.emit({ status: 400 });
      return new Response(invalid.message, { status: 400 });
    }

    const turnEvents = createTurnEventCollector();
    const imagePrepares: ImagePrepareDiagnostics[] = [];
    const imageOmits: ImageOmitDiagnostics[] = [];
    // AI SDK V4 here — log model id only until evlog/ai supports V4 wrap.
    const modelId = this.#env.AI_MODEL?.trim() || DEFAULT_MODEL;

    log.set({
      action: "agent_turn",
      layer: AGENT_TURN_ADMISSION_LAYER,
      ai: {
        model: modelId,
        provider: "openai-compatible",
      },
      channel: {
        kind: payload.channel.kind,
        hasSessionScope: Boolean(payload.sessionScopeKey),
      },
      input: {
        textChars: payload.text.length,
        ...attachmentLogFields(payload.attachments),
      },
      ...(payload.correlationId
        ? { correlationId: payload.correlationId }
        : {}),
    });

    const runTurn = (): Promise<Response> =>
      this.#runPayloadTurn({
        imageOmits,
        imagePrepares,
        log,
        payload,
        turnEvents,
      });

    return await runWithImagePrepareDiagnosticsListener(
      (diagnostics) => {
        imagePrepares.push(diagnostics);
        logInfo(
          imagePrepareLogEvent({
            ...diagnostics,
            message: IMAGE_PREPARE_LOG_MESSAGE,
          })
        );
      },
      () =>
        runWithImageOmitDiagnosticsListener((omit) => {
          imageOmits.push(omit);
          logWarn({
            message: "pss-runtime image-omit",
            limit: omit.limit,
            mediaType: omit.mediaType,
            ...(omit.filename === undefined ? {} : { filename: omit.filename }),
          });
        }, runTurn)
    );
  }

  async #runPayloadTurn({
    imageOmits,
    imagePrepares,
    log,
    payload,
    turnEvents,
  }: {
    readonly imageOmits: ImageOmitDiagnostics[];
    readonly imagePrepares: ImagePrepareDiagnostics[];
    readonly log: ReturnType<typeof createTurnLogger>;
    readonly payload: NonNullable<
      Awaited<ReturnType<typeof parseAgentRequest>>
    >;
    readonly turnEvents: ReturnType<typeof createTurnEventCollector>;
  }): Promise<Response> {
    try {
      this.#channel = payload.channel;
      this.#sessionScopeKey = payload.sessionScopeKey;
      const binding = durableObjectChannelBinding(payload.channel);
      const session = this.#ensureTurnSession(binding);
      const sendMessage = this.#sendMessageSetup(payload.channel);
      const agentInput = this.#parseAgentInput(payload, log);
      if (agentInput instanceof Response) {
        return agentInput;
      }

      const assistantMessages: string[] = [];
      const delivery = await this.#deliverWithObservability(
        session,
        agentInput,
        turnEvents,
        payload.channel.kind,
        assistantMessages
      );

      if (delivery.mode === "send" && delivery.delivered) {
        await this.#indexTurn(
          binding,
          agentTurnIndexText(payload),
          sendMessage,
          assistantMessages,
          payload.sessionScopeKey
        );
      }

      return this.#deliveryResponse({
        delivery,
        imageOmits,
        imagePrepares,
        log,
        sendMessage,
        turnEvents,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      log.error(failure);

      // AI gateway timeouts should not crash the telegram path with a silent 500.
      // Try one direct channel message so the user sees a retry hint.
      if (isAiGatewayTimeoutError(failure)) {
        const recovered = await this.#trySendGatewayTimeoutNotice(payload);
        if (recovered) {
          log.set({
            delivery: {
              delivered: true,
              mode: "send",
              outcome: "gateway_timeout_notice",
            },
            turn: turnEvents.summary(),
            ...summarizeImagePrepares(imagePrepares),
            ...summarizeImageOmits(imageOmits),
          });
          log.emit({ status: 200 });
          return Response.json({
            delivered: true,
            mode: "send",
            outcome: "gateway_timeout_notice",
          });
        }
      }

      log.set({
        delivery: { delivered: false, outcome: "error" },
        turn: turnEvents.summary(),
        ...summarizeImagePrepares(imagePrepares),
        ...summarizeImageOmits(imageOmits),
      });
      log.emit({ status: 500 });
      throw error;
    }
  }

  async #trySendGatewayTimeoutNotice(
    payload: NonNullable<Awaited<ReturnType<typeof parseAgentRequest>>>
  ): Promise<boolean> {
    try {
      const setup = this.#sendMessageSetup(payload.channel);
      await setup.options.sink.send(
        payload.channel,
        "모델 응답이 지연됐어. 잠시 후 다시 한 번 보내줄래?"
      );
      return true;
    } catch {
      return false;
    }
  }

  #parseAgentInput(
    payload: NonNullable<Awaited<ReturnType<typeof parseAgentRequest>>>,
    log: ReturnType<typeof createTurnLogger>
  ): AgentInput | Response {
    try {
      return agentInputFromRequest(payload);
    } catch (error) {
      if (error instanceof InvalidAttachmentBase64Error) {
        const invalid = workerErrors.INVALID_TURN_PAYLOAD();
        log.error(invalid);
        log.set({ outcome: "invalid_attachment_base64" });
        log.emit({ status: 400 });
        return new Response(invalid.message, { status: 400 });
      }
      throw error;
    }
  }

  async #deliverWithObservability(
    session: TurnSession,
    agentInput: AgentInput,
    turnEvents: ReturnType<typeof createTurnEventCollector>,
    channelKind: ChannelAddress["kind"],
    assistantMessages: string[]
  ): Promise<Awaited<ReturnType<TurnSession["deliver"]>>> {
    const previousObservability = this.#observability;
    let ownsObservability = false;
    try {
      return await session.deliver(agentInput, {
        onAssistantOutput: (text) => {
          assistantMessages.push(text);
        },
        onSendStarted: () => {
          ownsObservability = true;
          this.#observability = turnEvents;
          if (channelKind === "tui") {
            this.#tuiMessageCapture = [];
          }
        },
      });
    } finally {
      if (ownsObservability && this.#observability === turnEvents) {
        this.#observability = previousObservability;
      }
    }
  }

  #deliveryResponse({
    delivery,
    imageOmits,
    imagePrepares,
    log,
    sendMessage,
    turnEvents,
  }: {
    readonly delivery: Awaited<ReturnType<TurnSession["deliver"]>>;
    readonly imageOmits: ImageOmitDiagnostics[];
    readonly imagePrepares: ImagePrepareDiagnostics[];
    readonly log: ReturnType<typeof createTurnLogger>;
    readonly sendMessage: SendMessageToolSetup;
    readonly turnEvents: ReturnType<typeof createTurnEventCollector>;
  }): Response {
    const turnSummary = turnEvents.summary();
    log.set({
      delivery: {
        delivered: delivery.delivered,
        mode: delivery.mode,
        outcome: deliveryLogOutcome(delivery),
        ...(delivery.delivered
          ? {}
          : { error: "missing_send_message" as const }),
      },
      turn: {
        steps: turnSummary.steps,
        toolCalls: turnSummary.toolCalls,
        ...(turnSummary.errors.length > 0
          ? { errors: turnSummary.errors }
          : {}),
        ...(turnSummary.toolpick ? { toolpick: turnSummary.toolpick } : {}),
      },
      ...summarizeImagePrepares(imagePrepares),
      ...summarizeImageOmits(imageOmits),
    });

    if (!delivery.delivered) {
      log.error(workerErrors.MISSING_SEND_MESSAGE());
      log.emit({ status: 502 });
      return Response.json(
        {
          ...withCapturedMessages(
            { delivered: false, error: delivery.error },
            sendMessage.messages()
          ),
          mode: delivery.mode,
        },
        { status: 502 }
      );
    }

    log.emit({ status: 200 });
    return Response.json({
      ...withCapturedMessages({ delivered: true }, sendMessage.messages()),
      mode: delivery.mode,
    });
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

  #ensureTurnSession(binding: ChannelRuntimeBinding): TurnSession {
    if (this.#turnSession) {
      return this.#turnSession;
    }

    const sendMessage = this.#longLivedSendMessageOptions();
    this.#agent = createConfiguredAgent(this.#env, this.#platform.host(), {
      sendMessage,
      sessionTools: {
        currentConversationKey: () => {
          const channel = this.#channel;
          if (!channel) {
            return binding.channelKey;
          }
          return durableObjectChannelBinding(channel).channelKey;
        },
        currentSessionScopeKey: () => this.#sessionScopeKey,
        reader: this.#sessionIndexClient,
        transcriptReader: this.#sessionTranscriptClient,
      },
      observability: {
        log: (entry) => {
          this.#observability?.record(entry);
        },
      },
      toolpick: {
        onSelect: (metric) => {
          this.#observability?.recordToolpick({
            activeTools: metric.activeTools,
            reason: metric.reason,
            stepNumber: metric.stepNumber,
          });
        },
      },
    });
    this.#turnSession = createTurnSession(this.#agent.thread(binding.thread));
    return this.#turnSession;
  }

  #longLivedSendMessageOptions(): WorkerAgentSendMessageToolOptions {
    return {
      channel: () => this.#channel,
      sink: {
        send: async (channel, text) => {
          const setup = createRequestSendMessageToolSetup(this.#env, channel);
          const sent = await setup.options.sink.send(channel, text);
          if (channel.kind === "tui") {
            this.#tuiMessageCapture.push({
              channel: sent.channel,
              messageId: sent.messageId,
              text,
            });
          }
          return sent;
        },
      },
    };
  }

  #sendMessageSetup(channel: ChannelAddress): SendMessageToolSetup {
    if (channel.kind === "tui") {
      return {
        messages: () => this.#tuiMessageCapture,
        options: this.#longLivedSendMessageOptions(),
      };
    }
    return createRequestSendMessageToolSetup(this.#env, channel);
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
      logError(
        workerErrors.SESSION_INDEX_UPSERT_FAILED({
          cause: normalizeIndexError(error),
        }),
        { scope: "agent-do" }
      );
    }
  }
}

class AgentDurableObjectInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDurableObjectInvariantError";
  }
}

function deliveryLogOutcome(
  delivery: Awaited<ReturnType<TurnSession["deliver"]>>
): "delivered" | "missing_send_message" | "steered" {
  if (delivery.mode === "steer") {
    return "steered";
  }
  if (delivery.delivered) {
    return "delivered";
  }
  return "missing_send_message";
}

function normalizeIndexError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new AgentDurableObjectInvariantError(
        `Non-Error thrown: ${String(error)}`
      );
}

function isAiGatewayTimeoutError(error: Error): boolean {
  const text = `${error.name} ${error.message}`.toLowerCase();
  return (
    text.includes("gateway timeout") ||
    text.includes("ai_apicallerror") ||
    (text.includes("failed after") && text.includes("timeout")) ||
    text.includes("etimedout")
  );
}
