import type {
  ConversationAttachment,
  ConversationContext,
  ConversationMessage,
} from "./telegram-types";

export function collectTurnText(
  message: ConversationMessage,
  context?: ConversationContext
): string {
  return collectTurnTexts([...(context?.skipped ?? []), message]);
}

export function collectTurnTexts(
  messages: readonly ConversationMessage[]
): string {
  return messages
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

interface IngressBatchSummary {
  readonly correlationId?: string;
  readonly hasImages: boolean;
  readonly imageCount: number;
  readonly imageMediaTypes: readonly string[];
  readonly key: string;
  readonly messageCount: number;
  readonly subscribe: boolean;
  readonly textChars: number;
  readonly textPreview: string;
}

function isImageConversationAttachment(
  attachment: ConversationAttachment
): boolean {
  if (attachment.type === "image") {
    return true;
  }
  if (attachment.type !== "file") {
    return false;
  }
  return (
    attachment.mimeType?.trim().toLowerCase().startsWith("image/") ?? false
  );
}

export function summarizeIngressBatch(
  messages: readonly ConversationMessage[],
  meta: {
    readonly correlationId?: string;
    readonly key: string;
    readonly subscribe: boolean;
  }
): IngressBatchSummary {
  const text = collectTurnTexts(messages);
  const imageMediaTypes: string[] = [];
  let imageCount = 0;
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!isImageConversationAttachment(attachment)) {
        continue;
      }
      imageCount += 1;
      const mediaType =
        attachment.mimeType?.trim().toLowerCase() ||
        (attachment.type === "image" ? "image/jpeg" : "image/unknown");
      if (!imageMediaTypes.includes(mediaType)) {
        imageMediaTypes.push(mediaType);
      }
    }
  }
  const textPreview =
    text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}...`;
  return {
    key: meta.key,
    messageCount: messages.length,
    hasImages: imageCount > 0,
    imageCount,
    imageMediaTypes,
    subscribe: meta.subscribe,
    textChars: text.length,
    textPreview,
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
  };
}

export function formatIngressDryRunReply(summary: IngressBatchSummary): string {
  const imageLine = summary.hasImages
    ? `images=${summary.imageCount} types=[${summary.imageMediaTypes.join(", ")}]`
    : "images=0 (none attached)";
  const lines = [
    "🧪 ingress dry-run (Layer 1 only — agent skipped)",
    `fragments=${summary.messageCount} ${imageLine} textChars=${summary.textChars}`,
  ];
  if (summary.textPreview) {
    lines.push(`text: ${summary.textPreview}`);
  }
  if (summary.correlationId) {
    lines.push(`correlationId=${summary.correlationId}`);
  }
  return lines.join("\n");
}
