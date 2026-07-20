import type { AgentEvent, AgentInput, AgentTurn } from "@minpeter/pss-runtime";
import { collectTurnDelivery } from "./agent";

const MISSING_SEND_MESSAGE_ERROR = "missing_send_message";
export const TOOL_ONLY_DELIVERY_RECOVERY_PROMPT =
  "Your previous user-triggered turn ended without a successful send_message tool result. The user still has not received your answer. Using the immediately preceding user request and any assistant text you already drafted, call send_message now. Do not answer in assistant text only.";

export interface WorkerAgentThreadSender {
  send(input: AgentInput): Promise<AgentTurn>;
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
  readonly channel: string;
  readonly messageId: string;
  readonly text: string;
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
  input: AgentInput,
  options: DeliverToolOnlyTurnOptions = {}
): Promise<WorkerAgentDeliveryResponse> {
  const collectOptions = {
    ...(options.onAssistantOutput
      ? { onAssistantOutput: options.onAssistantOutput }
      : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
  const firstRun = await thread.send(input);
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
