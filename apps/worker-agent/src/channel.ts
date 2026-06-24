import { z } from "zod";

export const ChannelAddressSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["telegram", "tui"]),
  })
  .strict();

export type ChannelAddress = z.infer<typeof ChannelAddressSchema>;

export interface ChannelSentMessage {
  readonly messageId: string;
  readonly threadId: string;
}

export interface ChannelMessageSink {
  send(channel: ChannelAddress, text: string): Promise<ChannelSentMessage>;
}

export function channelKey(channel: ChannelAddress): string {
  return `${channel.kind}:${channel.id}`;
}
