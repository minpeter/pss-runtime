import { z } from "zod";

import { type ChannelAddress, ChannelAddressSchema } from "./channel";

const AgentRequestSchema = z
  .object({
    channel: ChannelAddressSchema,
    text: z.string(),
  })
  .strict();

export interface AgentRequestPayload {
  readonly channel: ChannelAddress;
  readonly text: string;
}

export async function parseAgentRequest(
  request: Request
): Promise<AgentRequestPayload | undefined> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }

  const result = AgentRequestSchema.safeParse(payload);
  if (!result.success) {
    return;
  }

  const channelId = result.data.channel.id.trim();
  const text = result.data.text.trim();
  return channelId && text
    ? { channel: { id: channelId, kind: result.data.channel.kind }, text }
    : undefined;
}
