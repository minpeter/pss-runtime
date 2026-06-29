import type { WorkerAgentDeliveredMessage } from "./agent-do-delivery";
import type { ChannelMessageSink, ChannelSentMessage } from "./channel";
import { channelKey } from "./channel";

export interface TuiResponseMessageSink {
  readonly messages: () => readonly WorkerAgentDeliveredMessage[];
  readonly sink: ChannelMessageSink;
}

export class TuiResponseMessageSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuiResponseMessageSinkError";
  }
}

export function createTuiResponseMessageSink(): TuiResponseMessageSink {
  const messages: WorkerAgentDeliveredMessage[] = [];

  return {
    messages: () => [...messages],
    sink: {
      send: (channel, text): Promise<ChannelSentMessage> => {
        if (channel.kind !== "tui") {
          return Promise.reject(
            new TuiResponseMessageSinkError(
              "TUI response sink can only send to tui channels."
            )
          );
        }

        const sent = {
          channel: channelKey(channel),
          messageId: `tui-${messages.length + 1}`,
        };
        messages.push({
          ...sent,
          text,
        });
        return Promise.resolve(sent);
      },
    },
  };
}
