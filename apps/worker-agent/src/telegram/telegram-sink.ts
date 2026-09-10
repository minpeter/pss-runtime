import { createTelegramAdapter } from "@chat-adapter/telegram";

import type {
  ChannelAddress,
  ChannelMessageSink,
  ChannelSentMessage,
} from "../channel";
import { channelKey } from "../channel";

interface TelegramMessageSinkOptions {
  /** Loopback Bot API override for local dry-run validation; unset in production. */
  readonly apiBaseUrl?: string;
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
  apiBaseUrl,
  botToken,
  userName,
}: TelegramMessageSinkOptions): ChannelMessageSink {
  const adapter = createTelegramAdapter({
    botToken,
    mode: "webhook",
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
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
        channel: channelKey(channel),
        messageId: sent.id,
      };
    },
  };
}
