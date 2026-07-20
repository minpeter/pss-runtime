import type {
  ImageOmitDiagnostics,
  ImagePrepareDiagnostics,
} from "@minpeter/pss-runtime";
import {
  IMAGE_PREPARE_LOG_MESSAGE,
  runWithImageOmitDiagnosticsListener,
  runWithImagePrepareDiagnosticsListener,
} from "@minpeter/pss-runtime";

import type { ChannelAddress } from "../channel";
import { durableObjectChannelBinding } from "../channel";
import type { Env } from "../env";
import { AGENT_TURN_ADMISSION_LAYER } from "../message-path-layers";
import { createTurnEventCollector } from "../observability";
import type { SessionIndexClient } from "../session-index/session-index-client";
import { workerErrors } from "../worker-errors";
import {
  attachmentLogFields,
  createTurnLogger,
  imagePrepareLogEvent,
  logInfo,
  logWarn,
  summarizeImageOmits,
  summarizeImagePrepares,
} from "../worker-log";
import { DEFAULT_MODEL } from "./agent";
import {
  type AgentRequestPayload,
  parseAgentRequest,
} from "./agent-do-request";
import type { SendMessageToolSetup } from "./agent-do-send-message";
import type { AgentDoSession } from "./agent-do-session";
import { indexTurnDelivery } from "./agent-do-turn-delivery-index";
import { parseTurnAgentInput } from "./agent-do-turn-delivery-input";
import { deliverWithObservability } from "./agent-do-turn-delivery-observability";
import { createDeliveryResponse } from "./agent-do-turn-delivery-response";
import type { AgentDoState } from "./agent-do-types";
import { agentTurnIndexText } from "./agent-input";

interface AgentDoTurnOptions {
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
        await indexTurnDelivery({
          assistantMessages,
          binding,
          sendMessage,
          sessionIndexClient: this.#sessionIndexClient,
          sessionScopeKey: payload.sessionScopeKey,
          userText: agentTurnIndexText(payload),
        });
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
}
