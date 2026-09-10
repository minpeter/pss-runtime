import { sanitizeTerminalText, stripTerminalEscapes } from "../terminal-safety";
import type { BaseToolCallView } from "../tool-call-view";

export const ANSI_RESET = "\x1b[0m";
// Pretty-block bodies are re-wrapped in the gray background per line, so a
// colored token must restore fg-default + gray bg to keep the right padding
// from losing its background.
export const RESTORE_ON_GRAY_BG = "\x1b[39m\x1b[100m";

export const normalizedLines = (text: string): string[] =>
  sanitizeTerminalText(text).split("\n");

/** Like `normalizedLines`, but escape sequences are removed, not escaped. */
export const strippedLines = (text: string): string[] =>
  stripTerminalEscapes(text).split("\n");

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const stringField = (obj: unknown, key: string): string | undefined => {
  if (!isRecord(obj)) {
    return;
  }
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const formatFileHeader = (operation: string, path: string): string => {
  const safePath = sanitizeTerminalText(path, path.length);
  const longestRun = Array.from(safePath.matchAll(/`+/g)).reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0
  );
  const fence = "`".repeat(longestRun + 1);
  return `**${operation}** ${fence} ${safePath} ${fence}`;
};

export const formatWriteHeader = (path: string): string =>
  formatFileHeader("write", path);

export const formatEditHeader = (path: string): string =>
  formatFileHeader("edit", path);

const MAX_SINGLE_LINE = 200;

const toSingleLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  const half = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, half)}...${text.slice(text.length - half)}`;
};

/** Single-line, length-bounded command rendered inside the bash header. */
export const formatShellCommand = (command: string): string =>
  truncateMiddle(toSingleLine(command), MAX_SINGLE_LINE);

export const formatShellHeader = (command: string): string =>
  `**bash** \`${sanitizeTerminalText(formatShellCommand(command))}\``;

const formatPatternHeader = (
  operation: string,
  pattern: string,
  context: readonly string[]
): string => {
  const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
  return `**${operation}** ${formatPatternSegment(pattern)}${suffix}`;
};

const formatPatternSegment = (value: string): string => {
  const safe = sanitizeTerminalText(value, value.length);
  const longest = Array.from(safe.matchAll(/`+/g)).reduce(
    (maximum, match) => Math.max(maximum, match[0].length),
    0
  );
  const fence = "`".repeat(longest + 1);
  return `${fence} ${safe} ${fence}`;
};

export const formatGlobHeader = (pattern: string, input: unknown): string => {
  const path = stringField(input, "path");
  return formatPatternHeader(
    "glob",
    pattern,
    path ? [`path: ${formatPatternSegment(path)}`] : []
  );
};

export const formatGrepHeader = (pattern: string, input: unknown): string => {
  const context: string[] = [];
  const path = stringField(input, "path");
  if (path) {
    context.push(`path: ${formatPatternSegment(path)}`);
  }
  const include = stringField(input, "include");
  if (include) {
    context.push(`include: ${formatPatternSegment(include)}`);
  }
  return formatPatternHeader("grep", pattern, context);
};

export const numberField = (obj: unknown, key: string): number | undefined => {
  if (!isRecord(obj)) {
    return;
  }
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

export const formatReadHeader = (
  path: string,
  input: unknown,
  isDirectory = false
): string => {
  const parts: string[] = [];
  for (const key of ["offset", "limit"]) {
    const value = numberField(input, key);
    if (value !== undefined) {
      parts.push(`${key}: ${value}`);
    }
  }
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${formatFileHeader(isDirectory ? "read dir" : "read", path)}${suffix}`;
};

export const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return sanitizeTerminalText(value);
  }
  try {
    return sanitizeTerminalText(JSON.stringify(value, null, 2));
  } catch {
    return sanitizeTerminalText(String(value));
  }
};

export const renderToolError = (
  view: BaseToolCallView,
  toolName: string
): boolean => {
  const error = view.getError();
  if (error === undefined) {
    return false;
  }
  view.setPrettyBlock(`**${toolName}** error`, safeStringify(error), {
    isError: true,
  });
  return true;
};
