import type {
  AgentInput,
  ImageOmitDiagnostics,
  ImagePrepareDiagnostics,
} from "@minpeter/pss-runtime";

import { withCapturedMessages } from "./agent-do-delivery";
import type { AgentRequestPayload } from "./agent-do-request";
import type { SendMessageToolSetup } from "./agent-do-send-message";
import type { TurnSession } from "./agent-do-turn-session";
import type { AgentDoState } from "./agent-do-types";
import {
  agentInputFromRequest,
  InvalidAttachmentBase64Error,
} from "./agent-input";
import type { ChannelAddress } from "./channel";
import type { createTurnEventCollector } from "./observability";
import { workerErrors } from "./worker-errors";
import {
  type createTurnLogger,
  summarizeImageOmits,
  summarizeImagePrepares,
} from "./worker-log";

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
