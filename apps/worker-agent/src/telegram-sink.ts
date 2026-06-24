import { createTelegramAdapter } from "@chat-adapter/telegram";

import type {
  ChannelAddress,
  ChannelMessageSink,
  ChannelSentMessage,
} from "./channel";

export interface TelegramMessageSinkOptions {
  readonly botToken: string;
  readonly userName?: string;
}

export class TelegramMessageSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramMessageSinkError";
  }
}

export function createTelegramMessageSink({
  botToken,
  userName,
}: TelegramMessageSinkOptions): ChannelMessageSink {
  const adapter = createTelegramAdapter({
    botToken,
    mode: "webhook",
    ...(userName ? { userName } : {}),
  });

  return {
    send: async (
      channel: ChannelAddress,
      text: string
    ): Promise<ChannelSentMessage> => {
      if (channel.kind !== "telegram") {
        throw new TelegramMessageSinkError(
          "Telegram sink can only send to telegram channels."
        );
      }

      const sent = await adapter.postChannelMessage(channel.id, text);
      return {
        messageId: sent.id,
        threadId: sent.threadId,
      };
    },
  };
}
