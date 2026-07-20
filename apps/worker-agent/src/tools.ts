import type { AgentOptions } from "@minpeter/pss-runtime";
import { z } from "zod";

import type { ChannelAddress, ChannelMessageSink } from "./channel";

export const SEND_MESSAGE_TOOL_NAME = "send_message";
const SendMessageToolInputSchema = z
  .object({
    text: z.string().describe("The exact user-visible message to send."),
  })
  .strict();

interface SendMessageToolResult {
  readonly channel: string;
  readonly delivered: true;
  readonly messageId: string;
}

export interface WorkerAgentSendMessageToolOptions {
  readonly channel: () => ChannelAddress | undefined;
  readonly sink: ChannelMessageSink;
}

export type WorkerAgentToolSet = NonNullable<AgentOptions["tools"]>;
type SendMessageTool = WorkerAgentToolSet["send_message"] & {
  readonly retryPolicy: "manual-recovery";
};

export class SendMessageToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendMessageToolConfigError";
  }
}

export class SendMessageToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendMessageToolInputError";
  }
}

export function createWorkerAgentTools(
  options: WorkerAgentSendMessageToolOptions
): WorkerAgentToolSet {
  return {
    send_message: createSendMessageTool(options),
  };
}

export function createSendMessageTool(
  options: WorkerAgentSendMessageToolOptions
): SendMessageTool {
  return {
    description: "Send a user-visible message to the current channel.",
    execute: async (input: unknown): Promise<SendMessageToolResult> => {
      const message = SendMessageToolInputSchema.parse(input);
      const text = message.text.trim();
      if (!text) {
        throw new SendMessageToolInputError("send_message.text is required.");
      }

      const channel = options.channel();
      if (!channel) {
        throw new SendMessageToolConfigError(
          "send_message requires a current channel."
        );
      }

      const sent = await options.sink.send(channel, text);
      return {
        channel: sent.channel,
        delivered: true,
        messageId: sent.messageId,
      };
    },
    inputSchema: SendMessageToolInputSchema,
    retryPolicy: "manual-recovery",
  };
}

export function isDeliveredSendMessageToolOutput(output: unknown): boolean {
  if (isSendMessageToolResult(output)) {
    return true;
  }

  if (isJsonToolOutput(output)) {
    return isSendMessageToolResult(output.value);
  }

  return false;
}

function isSendMessageToolResult(
  value: unknown
): value is SendMessageToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "delivered" in value &&
    value.delivered === true &&
    "messageId" in value &&
    typeof value.messageId === "string" &&
    "channel" in value &&
    typeof value.channel === "string"
  );
}

function isJsonToolOutput(
  value: unknown
): value is { readonly type: "json"; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "json" &&
    "value" in value
  );
}
