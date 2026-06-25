import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";

import { collectTurnDelivery } from "./agent";
import {
  isDeliveredSendMessageToolOutput,
  SEND_MESSAGE_TOOL_NAME,
} from "./tools";

const MISSING_SEND_MESSAGE_ERROR = "missing_send_message";
export const TOOL_ONLY_DELIVERY_RECOVERY_PROMPT =
  "Your previous user-triggered turn ended without a successful send_message tool result. The user still has not received your answer. Using the immediately preceding user request and any assistant text you already drafted, call send_message now. Do not answer in assistant text only.";

export interface WorkerAgentThreadSender {
  send(input: string): Promise<AgentTurn>;
}

export interface DeliverToolOnlyTurnOptions {
  readonly onAssistantOutput?: (text: string) => void;
  readonly onEvent?: (event: AgentEvent) => void;
}

export type WorkerAgentDeliveryResponse =
  | {
      readonly delivered: true;
      readonly messages?: readonly WorkerAgentDeliveredMessage[];
    }
  | {
      readonly delivered: false;
      readonly error: typeof MISSING_SEND_MESSAGE_ERROR;
    };

export interface WorkerAgentDeliveredMessage {
  readonly messageId: string;
  readonly text: string;
  readonly threadId: string;
}

export function withCapturedMessages(
  delivery: WorkerAgentDeliveryResponse,
  messages: readonly WorkerAgentDeliveredMessage[]
): WorkerAgentDeliveryResponse {
  if (!delivery.delivered || messages.length === 0) {
    return delivery;
  }

  return {
    delivered: true,
    messages,
  };
}

export async function deliverToolOnlyTurn(
  thread: WorkerAgentThreadSender,
  text: string,
  options: DeliverToolOnlyTurnOptions = {}
): Promise<WorkerAgentDeliveryResponse> {
  const collectOptions = {
    ...(options.onAssistantOutput
      ? { onAssistantOutput: options.onAssistantOutput }
      : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
  const firstRun = await thread.send(text);
  const firstDelivery = await collectTurnDelivery(firstRun, collectOptions);
  if (firstDelivery.deliveredByTool) {
    return { delivered: true };
  }

  const recoveryRun = await thread.send(TOOL_ONLY_DELIVERY_RECOVERY_PROMPT);
  const recoveryDelivery = await collectTurnDelivery(
    recoveryRun,
    collectOptions
  );
  if (recoveryDelivery.deliveredByTool) {
    return { delivered: true };
  }

  return {
    delivered: false,
    error: MISSING_SEND_MESSAGE_ERROR,
  };
}

export function isSendMessageDeliveryEvent(event: AgentEvent): boolean {
  return (
    event.type === "tool-result" &&
    event.toolName === SEND_MESSAGE_TOOL_NAME &&
    isDeliveredSendMessageToolOutput(event.output)
  );
}
