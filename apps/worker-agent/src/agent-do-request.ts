import { z } from "zod";

import {
  AGENT_MAX_BASE64_CHARS_PER_IMAGE,
  AGENT_MAX_TURN_BASE64_CHARS,
  AGENT_MAX_TURN_IMAGES,
} from "./attachment-limits";
import { type ChannelAddress, ChannelAddressSchema } from "./channel";

const AgentAttachmentSchema = z
  .object({
    dataBase64: z.string().min(1).max(AGENT_MAX_BASE64_CHARS_PER_IMAGE),
    filename: z.string().optional(),
    mediaType: z.string().min(1),
  })
  .strict();

const AgentRequestSchema = z
  .object({
    attachments: z
      .array(AgentAttachmentSchema)
      .max(AGENT_MAX_TURN_IMAGES)
      .optional(),
    channel: ChannelAddressSchema,
    correlationId: z.string().optional(),
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
  readonly correlationId?: string;
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
  const correlationId = result.data.correlationId?.trim();
  const text = (result.data.text ?? "").trim();
  const attachments = normalizeAttachments(result.data.attachments);
  if (attachments === undefined) {
    // Over limit: reject the whole turn (do not silently drop images).
    return;
  }
  if (!(channelId && (text || attachments.length > 0))) {
    return;
  }

  return {
    attachments,
    channel: { id: channelId, kind: result.data.channel.kind },
    ...(correlationId ? { correlationId } : {}),
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
    text,
  };
}

/**
 * Normalize attachments. Returns `undefined` when limits are exceeded so the
 * DO can reject with 400 instead of continuing as text-only.
 */
function normalizeAttachments(
  attachments: readonly AgentRequestAttachment[] | undefined
): readonly AgentRequestAttachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: AgentRequestAttachment[] = [];
  let totalBase64Chars = 0;
  for (const attachment of attachments) {
    const mediaType = attachment.mediaType.trim();
    const dataBase64 = attachment.dataBase64.trim();
    const filename = attachment.filename?.trim();
    if (!(mediaType && dataBase64)) {
      continue;
    }
    if (
      normalized.length >= AGENT_MAX_TURN_IMAGES ||
      dataBase64.length > AGENT_MAX_BASE64_CHARS_PER_IMAGE
    ) {
      return;
    }
    totalBase64Chars += dataBase64.length;
    if (totalBase64Chars > AGENT_MAX_TURN_BASE64_CHARS) {
      return;
    }
    normalized.push({
      dataBase64,
      mediaType,
      ...(filename ? { filename } : {}),
    });
  }
  return normalized;
}
