import type { AgentInput, UserMessageContentPart } from "@minpeter/pss-runtime";

import type { AgentRequestAttachment } from "./agent-do-request";

/**
 * Build runtime AgentInput from text + base64 image attachments.
 * Attachments are decoded to Uint8Array for HostAttachmentStore staging.
 */
export function agentInputFromRequest(payload: {
  readonly attachments: readonly AgentRequestAttachment[];
  readonly text: string;
}): AgentInput {
  if (payload.attachments.length === 0) {
    return payload.text;
  }

  const parts: UserMessageContentPart[] = [];
  if (payload.text) {
    parts.push({ text: payload.text, type: "text" });
  }

  for (const attachment of payload.attachments) {
    parts.push({
      data: decodeBase64(attachment.dataBase64),
      mediaType: attachment.mediaType,
      type: "file",
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }

  return parts;
}

/** Index / logging label for multimodal turns (no image bytes). */
export function agentTurnIndexText(payload: {
  readonly attachments: readonly AgentRequestAttachment[];
  readonly text: string;
}): string {
  if (payload.attachments.length === 0) {
    return payload.text;
  }
  const imageLabel =
    payload.attachments.length === 1
      ? "[image]"
      : `[${payload.attachments.length} images]`;
  return payload.text ? `${payload.text}\n${imageLabel}` : imageLabel;
}

export class InvalidAttachmentBase64Error extends Error {
  constructor(message = "Invalid attachment base64") {
    super(message);
    this.name = "InvalidAttachmentBase64Error";
  }
}

export function decodeBase64(dataBase64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(dataBase64);
  } catch {
    throw new InvalidAttachmentBase64Error();
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
