import {
  createRequestSendMessageToolSetup,
  type SendMessageToolSetup,
} from "./agent-do-send-message";
import type { AgentDoState } from "./agent-do-types";
import type { ChannelAddress } from "./channel";
import type { Env } from "./env";
import type { WorkerAgentSendMessageToolOptions } from "./tools";

export function createLongLivedSendMessageOptions(
  env: Env,
  state: AgentDoState
): WorkerAgentSendMessageToolOptions {
  return {
    channel: () => state.channel,
    sink: {
      send: async (channel, text) => {
        const setup = createRequestSendMessageToolSetup(env, channel);
        const sent = await setup.options.sink.send(channel, text);
        if (channel.kind === "tui") {
          state.tuiMessageCapture.push({
            channel: sent.channel,
            messageId: sent.messageId,
            text,
          });
        }
        return sent;
      },
    },
  };
}

export function createTurnSendMessageSetup(
  env: Env,
  state: AgentDoState,
  channel: ChannelAddress
): SendMessageToolSetup {
  if (channel.kind === "tui") {
    return {
      messages: () => state.tuiMessageCapture,
      options: createLongLivedSendMessageOptions(env, state),
    };
  }
  return createRequestSendMessageToolSetup(env, channel);
}
