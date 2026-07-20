import type { AgentRequestAttachment } from "./agent-do-request";
import type {
  ConversationAttachment,
  ConversationMessage,
} from "./telegram-types";
import {
  TELEGRAM_MAX_RAW_IMAGE_BYTES,
  TELEGRAM_MAX_TURN_IMAGES,
  TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES,
} from "./telegram-types";
import { logWarn } from "./worker-log";

const DEFAULT_IMAGE_MEDIA_TYPE = "image/jpeg";

export function collectTurnImageAttachments(
  message: ConversationMessage
): Promise<readonly AgentRequestAttachment[]> {
  return collectTurnImages([message]);
}

export class TelegramAttachmentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramAttachmentLimitError";
  }
}

export async function collectTurnImages(
  messages: readonly ConversationMessage[]
): Promise<readonly AgentRequestAttachment[]> {
  const images: AgentRequestAttachment[] = [];
  let totalRawBytes = 0;

  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const next = await collectOneTurnImage(attachment, {
        count: images.length,
        totalRawBytes,
      });
      if (!next) {
        continue;
      }
      totalRawBytes += next.rawBytes;
      images.push(next.attachment);
    }
  }

  return images;
}

async function collectOneTurnImage(
  attachment: ConversationAttachment,
  budget: { readonly count: number; readonly totalRawBytes: number }
): Promise<
  | {
      readonly attachment: AgentRequestAttachment;
      readonly rawBytes: number;
    }
  | undefined
> {
  if (!isImageAttachment(attachment)) {
    return;
  }

  const bytes = await readAttachmentBytes(attachment);
  if (!bytes || bytes.byteLength === 0) {
    logWarn({
      action: "attachment_empty",
      scope: "telegram",
    });
    return;
  }

  assertTelegramImageBudget(bytes.byteLength, budget);

  return {
    rawBytes: bytes.byteLength,
    attachment: {
      dataBase64: bytesToBase64(bytes),
      mediaType: imageMediaType(attachment),
      ...(attachment.name?.trim() ? { filename: attachment.name.trim() } : {}),
    },
  };
}

function assertTelegramImageBudget(
  rawBytes: number,
  budget: { readonly count: number; readonly totalRawBytes: number }
): void {
  if (rawBytes > TELEGRAM_MAX_RAW_IMAGE_BYTES) {
    throw new TelegramAttachmentLimitError(
      `Image exceeds max raw size of ${TELEGRAM_MAX_RAW_IMAGE_BYTES} bytes before DO hop.`
    );
  }
  if (budget.count >= TELEGRAM_MAX_TURN_IMAGES) {
    throw new TelegramAttachmentLimitError(
      `Turn exceeds max of ${TELEGRAM_MAX_TURN_IMAGES} images.`
    );
  }
  if (budget.totalRawBytes + rawBytes > TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES) {
    throw new TelegramAttachmentLimitError(
      `Turn exceeds max total raw image size of ${TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES} bytes.`
    );
  }
}

export function isImageAttachment(attachment: ConversationAttachment): boolean {
  if (attachment.type === "image") {
    return true;
  }
  if (attachment.type !== "file") {
    return false;
  }
  const mime = attachment.mimeType?.trim().toLowerCase() ?? "";
  return mime.startsWith("image/");
}

function imageMediaType(attachment: ConversationAttachment): string {
  const mime = attachment.mimeType?.trim();
  if (mime) {
    return mime;
  }
  return DEFAULT_IMAGE_MEDIA_TYPE;
}

async function readAttachmentBytes(
  attachment: ConversationAttachment
): Promise<Uint8Array | undefined> {
  if (attachment.data !== undefined) {
    return coerceBytes(attachment.data);
  }
  if (attachment.fetchData) {
    return coerceBytes(await attachment.fetchData());
  }
  return;
}

async function coerceBytes(
  value: ArrayBuffer | Blob | Uint8Array
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(await value.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x80_00;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
