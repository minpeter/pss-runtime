import {
  type ThreadAddress,
  type ThreadKey,
  threadStoreKey,
} from "@minpeter/pss-runtime";
import { z } from "zod";

export const ChannelAddressSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["telegram", "tui"]),
  })
  .strict();

export type ChannelAddress = z.infer<typeof ChannelAddressSchema>;

export interface ChannelSentMessage {
  readonly channel: string;
  readonly messageId: string;
}

export interface ChannelMessageSink {
  send(channel: ChannelAddress, text: string): Promise<ChannelSentMessage>;
}

export interface ChannelRuntimeBinding {
  readonly channel: ChannelAddress;
  readonly channelKey: string;
  readonly thread: ThreadKey;
  readonly threadKey: string;
}

export const CHANNEL_DURABLE_OBJECT_THREAD_KEY = "default";

export function channelKey(channel: ChannelAddress): string {
  return `${channel.kind}:${channel.id}`;
}

export function channelThreadAddress(channel: ChannelAddress): ThreadAddress {
  return {
    key: channel.id,
    scope: `channel:${channel.kind}`,
  };
}

export function localChannelBinding(
  channel: ChannelAddress
): ChannelRuntimeBinding {
  const thread = channelThreadAddress(channel);
  return bindChannelToThread(channel, thread);
}

export function durableObjectChannelBinding(
  channel: ChannelAddress
): ChannelRuntimeBinding {
  return bindChannelToThread(channel, CHANNEL_DURABLE_OBJECT_THREAD_KEY);
}

function bindChannelToThread(
  channel: ChannelAddress,
  thread: ThreadKey
): ChannelRuntimeBinding {
  return {
    channel,
    channelKey: channelKey(channel),
    thread,
    threadKey: threadStoreKey(thread),
  };
}
