import type { DefaultTextStyle, MarkdownTheme } from "@earendil-works/pi-tui";

const wrap =
  (open: string) =>
  (text: string): string =>
    `${open}${text}\x1b[0m`;

/**
 * Foreground label colors shared by the TUI event formatter and the tool
 * printer. Each function wraps text in a single SGR code and resets with
 * `\x1b[0m`, matching the ANSI the TUI emitted before themes were centralized.
 */
export const assistantText = wrap("\x1b[32m");
export const boldText = wrap("\x1b[1m");
export const darkGrayText = wrap("\x1b[90m");
export const dimText = wrap("\x1b[2m");
export const errorText = wrap("\x1b[31m");
export const italicText = wrap("\x1b[3m");
export const reasoningText = wrap("\x1b[35m");
export const strikethroughText = wrap("\x1b[9m");
export const toolText = wrap("\x1b[33m");
export const underlineText = wrap("\x1b[4m");
export const userText = wrap("\x1b[36m");

const identity = (text: string): string => text;

/**
 * Theme for rendering assistant output through pi-tui's `Markdown` component.
 * Structural chrome (borders, bullets, URLs) stays dim so the body text keeps
 * the assistant green applied by `markdownDefaultTextStyle`.
 */
export const markdownTheme: MarkdownTheme = {
  bold: boldText,
  code: darkGrayText,
  codeBlock: identity,
  codeBlockBorder: dimText,
  heading: boldText,
  hr: dimText,
  italic: italicText,
  link: underlineText,
  linkUrl: dimText,
  listBullet: dimText,
  quote: dimText,
  quoteBorder: dimText,
  strikethrough: strikethroughText,
  underline: underlineText,
};

/** Base style applied to markdown body text. */
export const markdownDefaultTextStyle: DefaultTextStyle = {
  color: assistantText,
};
