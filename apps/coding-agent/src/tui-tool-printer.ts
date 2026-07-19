import { truncateToWidth } from "@earendil-works/pi-tui";
import { darkGrayText } from "./tui-theme";

export interface TuiToolCallView {
  input: unknown;
  toolCallId: string;
  toolName: string;
}

export interface TuiToolResultView {
  output: unknown;
  toolCallId: string;
  toolName: string;
}

const defaultJsonLength = 220;
const errorPrefixPattern = /^Error: /;
const maxDetailLength = 600;
const toolCallIdDisplayEnd = 13;
const toolCallIdDisplayStart = 5;
const whitespacePattern = /\s+/g;

export const safeText = (text: string): string =>
  Array.from(text)
    .filter((value) => !isTerminalControlCharacter(value))
    .join("");

export const safeInlineText = (text: string): string =>
  safeText(text).replace(whitespacePattern, " ").trim();

/**
 * Truncate detail text to a maximum visible terminal column width. Uses
 * pi-tui's width-aware truncation so CJK/emoji (double-column) text cannot
 * overflow the budget the way character-count slicing did.
 */
export const truncateDetail = (
  text: string,
  maxLength = maxDetailLength
): string => truncateToWidth(text, maxLength);

export function formatToolCallForTui(event: TuiToolCallView): string {
  return `${formatToolLabel(event)} ${formatToolInput(event.input)}`;
}

export function formatToolResultForTui(event: TuiToolResultView): string {
  return `${formatToolLabel(event)} ${formatToolOutput(event.output)}`;
}

function formatToolLabel(event: {
  toolCallId: string;
  toolName: string;
}): string {
  return `${safeInlineText(event.toolName)}${darkGrayText(`#${shortToolCallId(event.toolCallId)}`)}`;
}

function isTerminalControlCharacter(value: string): boolean {
  const code = value.codePointAt(0);

  return (
    code !== undefined &&
    (code <= 0x08 ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f))
  );
}

function safeJson(value: unknown, maxLength = maxDetailLength): string {
  try {
    return truncateDetail(
      safeInlineText(JSON.stringify(value) ?? "undefined"),
      maxLength
    );
  } catch {
    return truncateDetail(safeInlineText(String(value)), maxLength);
  }
}

function shortToolCallId(toolCallId: string): string {
  // Fixed display window: do not parse separators; AI SDK call IDs usually put
  // the useful unique block after "call-", while other providers still render consistently.
  return safeInlineText(
    toolCallId.slice(toolCallIdDisplayStart, toolCallIdDisplayEnd)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoted(value: string, maxLength = 80): string {
  return `"${truncateDetail(safeInlineText(value), maxLength)}"`;
}

function formatToolInput(input: unknown): string {
  if (isRecord(input)) {
    const knownInput = formatKnownToolInput(input);

    if (knownInput) {
      return knownInput;
    }
  }

  return `input=${safeJson(input, 120)}`;
}

function formatKnownToolInput(
  input: Record<string, unknown>
): string | undefined {
  if (typeof input.query === "string") {
    return `query=${quoted(input.query)}`;
  }

  if (Array.isArray(input.urls)) {
    return formatUrls(input.urls);
  }
}

function formatUrls(urls: unknown[]): string {
  const first = urls[0];
  const label = typeof first === "string" ? first : String(first);

  return `urls=${urls.length} first=${quoted(label, 40)}`;
}

function formatToolOutput(output: unknown): string {
  if (!isRecord(output) || typeof output.type !== "string") {
    return `output=${safeJson(output, defaultJsonLength)}`;
  }

  if (output.type === "json") {
    return `json ${formatJsonOutputValue(output.value)}`;
  }

  if (typeof output.value === "string") {
    return `${output.type}=${quoted(
      output.value.replace(errorPrefixPattern, ""),
      72
    )}`;
  }

  if (output.type === "execution-denied") {
    return `denied=${quoted(String(output.reason ?? "no reason"), 100)}`;
  }

  return `${output.type} ${safeJson(output, 160)}`;
}

function formatJsonOutputValue(value: unknown): string {
  if (!isRecord(value)) {
    return safeJson(value, defaultJsonLength);
  }

  const knownOutput = formatKnownJsonOutputValue(value);

  return knownOutput ?? safeJson(value, defaultJsonLength);
}

function formatKnownJsonOutputValue(
  value: Record<string, unknown>
): string | undefined {
  const parts: string[] = [];

  if (Array.isArray(value.results)) {
    parts.push(`results=${value.results.length}`);

    const title = firstResultTitle(value.results);
    if (title) {
      parts.push(`top=${quoted(title, 36)}`);
    }
  }

  if (Array.isArray(value.errors)) {
    parts.push(`errors=${value.errors.length}`);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function firstResultTitle(results: unknown[]): string | undefined {
  const first = results.find(isRecord);

  if (!first) {
    return;
  }

  if (typeof first.title === "string") {
    return first.title;
  }

  if (typeof first.final_url === "string") {
    return first.final_url;
  }

  if (typeof first.url === "string") {
    return first.url;
  }
}
