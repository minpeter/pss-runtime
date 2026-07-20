import type {
  ImageOmitDiagnostics,
  ImagePrepareDiagnostics,
} from "@minpeter/pss-runtime";
import type { SendMessageToolSetup } from "../message-sinks";
import type { createTurnEventCollector } from "../observability";
import { workerErrors } from "../worker-errors";
import {
  type createTurnLogger,
  summarizeImageOmits,
  summarizeImagePrepares,
} from "../worker-log";
import { withCapturedMessages } from "./agent-do-delivery";
import type { TurnSession } from "./agent-do-turn-session";

type Delivery = Awaited<ReturnType<TurnSession["deliver"]>>;

export function createDeliveryResponse({
  delivery,
  imageOmits,
  imagePrepares,
  log,
  sendMessage,
  turnEvents,
}: {
  readonly delivery: Delivery;
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
  delivery: Delivery
): "delivered" | "missing_send_message" | "steered" {
  if (delivery.mode === "steer") {
    return "steered";
  }
  if (delivery.delivered) {
    return "delivered";
  }
  return "missing_send_message";
}
