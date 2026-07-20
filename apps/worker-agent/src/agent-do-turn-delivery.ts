import type {
  AgentInput,
  ImageOmitDiagnostics,
  ImagePrepareDiagnostics,
} from "@minpeter/pss-runtime";
import {
  IMAGE_PREPARE_LOG_MESSAGE,
  runWithImageOmitDiagnosticsListener,
  runWithImagePrepareDiagnosticsListener,
} from "@minpeter/pss-runtime";

import { DEFAULT_MODEL } from "./agent";
import { withCapturedMessages } from "./agent-do-delivery";
import {
  type AgentRequestPayload,
  parseAgentRequest,
} from "./agent-do-request";
import type { SendMessageToolSetup } from "./agent-do-send-message";
import type { AgentDoSession } from "./agent-do-session";
import type { TurnSession } from "./agent-do-turn-session";
import {
  type AgentDoState,
  AgentDurableObjectInvariantError,
} from "./agent-do-types";
import {
  agentInputFromRequest,
  agentTurnIndexText,
  InvalidAttachmentBase64Error,
} from "./agent-input";
import type { ChannelAddress, ChannelRuntimeBinding } from "./channel";
import { durableObjectChannelBinding } from "./channel";
import type { Env } from "./env";
import { AGENT_TURN_ADMISSION_LAYER } from "./message-path-layers";
import { createTurnEventCollector } from "./observability";
import type { SessionIndexClient } from "./session-index-client";
import { workerErrors } from "./worker-errors";
import {
  attachmentLogFields,
  createTurnLogger,
  imagePrepareLogEvent,
  logError,
  logInfo,
  logWarn,
  summarizeImageOmits,
  summarizeImagePrepares,
} from "./worker-log";

export interface AgentDoTurnOptions {
  readonly createSendMessage: (channel: ChannelAddress) => SendMessageToolSetup;
  readonly env: Env;
  readonly session: AgentDoSession;
  readonly sessionIndexClient: SessionIndexClient;
  readonly state: AgentDoState;
}

export class AgentDoTurn {
  readonly #createSendMessage: (
    channel: ChannelAddress
  ) => SendMessageToolSetup;
  readonly #env: Env;
  readonly #session: AgentDoSession;
  readonly #sessionIndexClient: SessionIndexClient;
  readonly #state: AgentDoState;

  constructor(options: AgentDoTurnOptions) {
    this.#createSendMessage = options.createSendMessage;
    this.#env = options.env;
    this.#session = options.session;
    this.#sessionIndexClient = options.sessionIndexClient;
    this.#state = options.state;
  }

  async handle(request: Request): Promise<Response> {
    const log = createTurnLogger(request);
    const payload = await parseAgentRequest(request);
    if (!payload) {
      const invalid = workerErrors.INVALID_TURN_PAYLOAD();
      log.error(invalid);
      log.set({ action: "agent_turn", outcome: "invalid_payload" });
      log.emit({ status: 400 });
      return new Response(invalid.message, { status: 400 });
    }

    const turnEvents = createTurnEventCollector();
    const imagePrepares: ImagePrepareDiagnostics[] = [];
    const imageOmits: ImageOmitDiagnostics[] = [];
    const modelId = this.#env.AI_MODEL?.trim() || DEFAULT_MODEL;

    log.set({
      action: "agent_turn",
      layer: AGENT_TURN_ADMISSION_LAYER,
      ai: { model: modelId, provider: "openai-compatible" },
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

    const runTurn = async (): Promise<Response> => {
      try {
        return await this.#runPayloadTurn({
          imageOmits,
          imagePrepares,
          log,
          payload,
          turnEvents,
        });
      } finally {
        this.#state.sessionEventLive.publish();
      }
    };

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
    readonly payload: AgentRequestPayload;
    readonly turnEvents: ReturnType<typeof createTurnEventCollector>;
  }): Promise<Response> {
    try {
      this.#state.channel = payload.channel;
      this.#state.sessionScopeKey = payload.sessionScopeKey;
      const binding = durableObjectChannelBinding(payload.channel);
      const session = await this.#session.ensureTurnSession(binding);
      const sendMessage = this.#createSendMessage(payload.channel);
      const agentInput = parseTurnAgentInput(payload, log);
      if (agentInput instanceof Response) {
        return agentInput;
      }

      const assistantMessages: string[] = [];
      const delivery = await deliverWithObservability(
        this.#state,
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

      return createDeliveryResponse({
        delivery,
        imageOmits,
        imagePrepares,
        log,
        sendMessage,
        turnEvents,
      });
    } catch (error) {
      log.error(error instanceof Error ? error : new Error(String(error)));
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

export function parseTurnAgentInput(
  payload: AgentRequestPayload,
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

export async function deliverWithObservability(
  state: AgentDoState,
  session: TurnSession,
  agentInput: AgentInput,
  turnEvents: ReturnType<typeof createTurnEventCollector>,
  channelKind: ChannelAddress["kind"],
  assistantMessages: string[]
): Promise<Awaited<ReturnType<TurnSession["deliver"]>>> {
  const previousObservability = state.observability;
  let ownsObservability = false;
  try {
    return await session.deliver(agentInput, {
      onAssistantOutput: (text) => {
        assistantMessages.push(text);
      },
      onSendStarted: () => {
        ownsObservability = true;
        state.observability = turnEvents;
        if (channelKind === "tui") {
          state.tuiMessageCapture = [];
        }
      },
    });
  } finally {
    if (ownsObservability && state.observability === turnEvents) {
      state.observability = previousObservability;
    }
  }
}

export function createDeliveryResponse({
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
      ...(delivery.delivered ? {} : { error: "missing_send_message" as const }),
    },
    turn: {
      steps: turnSummary.steps,
      toolCalls: turnSummary.toolCalls,
      ...(turnSummary.errors.length > 0 ? { errors: turnSummary.errors } : {}),
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
