import { splitReplyBubbles } from "./replies";

const BLOCK_OPEN = "<block>";
const BLOCK_CLOSE = "</block>";

export type ReplySegment =
  | { readonly kind: "plain"; readonly content: string }
  | { readonly kind: "block"; readonly content: string };

export function parseReplySegments(text: string): readonly ReplySegment[] {
  const segments: ReplySegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openIndex = text.indexOf(BLOCK_OPEN, cursor);
    if (openIndex === -1) {
      segments.push({ kind: "plain", content: text.slice(cursor) });
      break;
    }

    if (openIndex > cursor) {
      segments.push({ kind: "plain", content: text.slice(cursor, openIndex) });
    }

    const contentStart = openIndex + BLOCK_OPEN.length;
    const closeIndex = text.indexOf(BLOCK_CLOSE, contentStart);
    if (closeIndex === -1) {
      segments.push({ kind: "plain", content: text.slice(openIndex) });
      break;
    }

    segments.push({
      kind: "block",
      content: text.slice(contentStart, closeIndex),
    });
    cursor = closeIndex + BLOCK_CLOSE.length;
  }

  return segments.filter(
    (segment) => segment.content.length > 0
  );
}

export function telegramReplyBubbles(text: string): readonly string[] {
  const bubbles: string[] = [];

  for (const segment of parseReplySegments(text)) {
    if (segment.kind === "block") {
      const trimmed = segment.content.trim();
      if (trimmed.length > 0) {
        bubbles.push(trimmed);
      }
      continue;
    }

    bubbles.push(...splitReplyBubbles(segment.content));
  }

  return bubbles.length > 0 ? bubbles : [text];
}