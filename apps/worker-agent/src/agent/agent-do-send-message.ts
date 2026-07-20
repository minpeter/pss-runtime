import type { ChannelAddress } from "../channel";
import type { Env } from "../env";
import { createTelegramMessageSink } from "../telegram/telegram-sink";
import type { WorkerAgentSendMessageToolOptions } from "../tools";
import { createTuiResponseMessageSink } from "../tui/tui-response-sink";
import type { WorkerAgentDeliveredMessage } from "./agent-do-delivery";

export interface SendMessageToolSetup {
  readonly messages: () => readonly WorkerAgentDeliveredMessage[];
  readonly options: WorkerAgentSendMessageToolOptions;
}

export function createSendMessageToolOptions(
  env: Env,
  channel: () => ChannelAddress | undefined
): WorkerAgentSendMessageToolOptions {
  const userName = env.TELEGRAM_BOT_USERNAME?.trim();
  return {
    channel,
    sink: createTelegramMessageSink({
      botToken: env.TELEGRAM_BOT_TOKEN,
      ...(userName ? { userName } : {}),
    }),
  };
}

export function createRequestSendMessageToolSetup(
  env: Env,
  channel: ChannelAddress
): SendMessageToolSetup {
  switch (channel.kind) {
    case "telegram":
      return {
        messages: () => [],
        options: createSendMessageToolOptions(env, () => channel),
      };
    case "tui": {
      const responseSink = createTuiResponseMessageSink();
      return {
        messages: responseSink.messages,
        options: {
          channel: () => channel,
          sink: responseSink.sink,
        },
      };
    }
    default:
      return assertNever(channel.kind);
  }
}

function assertNever(value: never): never {
  throw new SendMessageToolSetupError(
    `Unexpected channel variant: ${String(value)}`
  );
}

class SendMessageToolSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendMessageToolSetupError";
  }
}
