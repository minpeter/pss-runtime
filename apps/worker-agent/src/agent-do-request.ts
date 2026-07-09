import { z } from "zod";

import { type ChannelAddress, ChannelAddressSchema } from "./channel";

const AgentAttachmentSchema = z
  .object({
    dataBase64: z.string().min(1),
    filename: z.string().optional(),
    mediaType: z.string().min(1),
  })
  .strict();

const AgentRequestSchema = z
  .object({
    attachments: z.array(AgentAttachmentSchema).optional(),
    channel: ChannelAddressSchema,
    sessionScopeKey: z.string().optional(),
    text: z.string().optional(),
  })
  .strict();

export interface AgentRequestAttachment {
  readonly dataBase64: string;
  readonly filename?: string;
  readonly mediaType: string;
}

export interface AgentRequestPayload {
  readonly attachments: readonly AgentRequestAttachment[];
  readonly channel: ChannelAddress;
  readonly sessionScopeKey?: string;
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
  const sessionScopeKey = result.data.sessionScopeKey?.trim();
  const text = (result.data.text ?? "").trim();
  const attachments = normalizeAttachments(result.data.attachments);
  if (!(channelId && (text || attachments.length > 0))) {
    return;
  }

  return {
    attachments,
    channel: { id: channelId, kind: result.data.channel.kind },
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
    text,
  };
}

function normalizeAttachments(
  attachments: readonly AgentRequestAttachment[] | undefined
): readonly AgentRequestAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: AgentRequestAttachment[] = [];
  for (const attachment of attachments) {
    const mediaType = attachment.mediaType.trim();
    const dataBase64 = attachment.dataBase64.trim();
    const filename = attachment.filename?.trim();
    if (!(mediaType && dataBase64)) {
      continue;
    }
    normalized.push({
      dataBase64,
      mediaType,
      ...(filename ? { filename } : {}),
    });
  }
  return normalized;
}
