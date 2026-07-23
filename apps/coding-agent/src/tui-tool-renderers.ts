import type { BaseToolCallView, ToolRendererMap } from "./tui-tool-call-view";

const MAX_SINGLE_LINE = 200;
const FETCH_TEXT_PREVIEW_LIMIT = 1500;

const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";
// Pretty-block bodies are re-wrapped in the gray background per line, so a
// colored token must restore fg-default + gray bg to keep the right padding
// from losing its background.
const RESTORE_ON_GRAY_BG = "\x1b[39m\x1b[100m";

// senpi's dark-theme diff scheme: plain red/green fg per line, changed words
// emphasized with inverse video instead of block backgrounds.
const DIFF_REMOVE_FG = "\x1b[31m";
const DIFF_ADD_FG = "\x1b[32m";
const DIFF_INVERSE_ON = "\x1b[7m";
const DIFF_INVERSE_OFF = "\x1b[27m";
// faint line-region tints behind the touched token; the strong inverse
// highlight marks only the intra-token characters that actually changed.
const DIFF_REMOVE_FAINT_BG = "\x1b[48;2;61;38;40m";
const DIFF_ADD_FAINT_BG = "\x1b[48;2;38;61;40m";
// unchanged context rows (identical on both sides) get a dim line number.
const DIFF_CONTEXT_DIM = "\x1b[2m";

// senpi dark-theme syntax palette (VS Code Dark+ hues), truecolor.
const fgRgb = (r: number, g: number, b: number): string =>
  `\x1b[38;2;${r};${g};${b}m`;
const SYN_COMMENT = fgRgb(0x6a, 0x99, 0x55);
const SYN_KEYWORD = fgRgb(0x56, 0x9c, 0xd6);
const SYN_FUNCTION = fgRgb(0xdc, 0xdc, 0xaa);
const SYN_VARIABLE = fgRgb(0x9c, 0xdc, 0xfe);
const SYN_STRING = fgRgb(0xce, 0x91, 0x78);
const SYN_NUMBER = fgRgb(0xb5, 0xce, 0xa8);
const SYN_TYPE = fgRgb(0x4e, 0xc9, 0xb0);
const SYN_OPERATOR = fgRgb(0xd4, 0xd4, 0xd4);

const HASHLINE_ANCHOR_PATTERN = /^\d+#[A-Z]+\|/gm;

const stripHashlineAnchors = (text: string): string =>
  text.replace(HASHLINE_ANCHOR_PATTERN, "");

const toSingleLine = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const truncateMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  const half = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, half)}...${text.slice(text.length - half)}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (obj: unknown, key: string): string | undefined => {
  if (!isRecord(obj)) {
    return;
  }
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const numberField = (obj: unknown, key: string): number | undefined => {
  if (!isRecord(obj)) {
    return;
  }
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const normalizedLines = (text: string): string[] =>
  text.replace(/\r\n/g, "\n").split("\n");

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const renderToolError = (view: BaseToolCallView, toolName: string): boolean => {
  const error = view.getError();
  if (error === undefined) {
    return false;
  }
  view.setPrettyBlock(`**${toolName}** error`, safeStringify(error), {
    isError: true,
  });
  return true;
};

interface EditOp {
  end?: string;
  lines: string;
  op: "append" | "prepend" | "replace";
  pos?: string;
}

const isEditOp = (value: unknown): value is EditOp => {
  if (!isRecord(value)) {
    return false;
  }
  const op = value.op;
  return (
    (op === "replace" || op === "append" || op === "prepend") &&
    typeof value.lines === "string"
  );
};

const editedLine = (line: string): string =>
  `${ANSI_GREEN}${line}${ANSI_RESET}`;

const formatEditHunk = (edit: EditOp): string =>
  normalizedLines(edit.lines).map(editedLine).join("\n");

interface DiffLine {
  kind: "add" | "remove";
  lineNo: number;
  text: string;
}

const DIFF_LINE_PATTERN = /^([+-])(\d+)(?:#[A-Z]+)?\|([\s\S]*)$/;

const parseDiffSection = (output: string): DiffLine[][] | undefined => {
  const lines = normalizedLines(output);
  const diffIndex = lines.indexOf("diff:");
  if (diffIndex < 0) {
    return;
  }

  const groups: DiffLine[][] = [];
  let current: DiffLine[] | undefined;
  for (const line of lines.slice(diffIndex + 1)) {
    if (line.startsWith("@@ edit")) {
      current = [];
      groups.push(current);
      continue;
    }
    const match = line.match(DIFF_LINE_PATTERN);
    if (!match) {
      continue;
    }
    if (!current) {
      current = [];
      groups.push(current);
    }
    current.push({
      kind: match[1] === "+" ? "add" : "remove",
      lineNo: Number(match[2]),
      text: match[3],
    });
  }

  return groups.length > 0 ? groups : undefined;
};

interface CodeToken {
  color: string;
  text: string;
}

const CODE_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

const CODE_TOKEN_PATTERN =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\\n]|\\.)*`?)|(\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g;

const UPPERCASE_START_PATTERN = /^[A-Z]/;

const classifyWordToken = (word: string): string => {
  if (CODE_KEYWORDS.has(word)) {
    return SYN_KEYWORD;
  }
  if (UPPERCASE_START_PATTERN.test(word)) {
    return SYN_TYPE;
  }
  return SYN_VARIABLE;
};

const tokenizeCode = (line: string): CodeToken[] => {
  const tokens: CodeToken[] = [];
  CODE_TOKEN_PATTERN.lastIndex = 0;
  let match = CODE_TOKEN_PATTERN.exec(line);
  while (match !== null) {
    const [text, comment, str, num, word] = match;
    if (comment !== undefined) {
      tokens.push({ color: SYN_COMMENT, text });
    } else if (str !== undefined) {
      tokens.push({ color: SYN_STRING, text });
    } else if (num !== undefined) {
      tokens.push({ color: SYN_NUMBER, text });
    } else if (word === undefined) {
      tokens.push({ color: SYN_OPERATOR, text });
    } else {
      tokens.push({ color: classifyWordToken(text), text });
    }
    match = CODE_TOKEN_PATTERN.exec(line);
  }

  // identifiers directly followed by "(" are function calls
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (
      token.color === SYN_VARIABLE &&
      next !== undefined &&
      next.text.startsWith("(")
    ) {
      token.color = SYN_FUNCTION;
    }
  }

  return tokens;
};

const highlightCodeLine = (line: string): string =>
  tokenizeCode(line)
    .map((token) => `${token.color}${token.text}${RESTORE_ON_GRAY_BG}`)
    .join("");

const highlightCode = (text: string): string =>
  normalizedLines(text).map(highlightCodeLine).join("\n");

const markChangedTokens = (
  oldTokens: readonly string[],
  newTokens: readonly string[]
): { newChanged: boolean[]; oldChanged: boolean[] } => {
  const rows = oldTokens.length;
  const cols = newTokens.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0)
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        oldTokens[i] === newTokens[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const oldChanged = new Array<boolean>(rows).fill(true);
  const newChanged = new Array<boolean>(cols).fill(true);
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldTokens[i] === newTokens[j]) {
      oldChanged[i] = false;
      newChanged[j] = false;
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { newChanged, oldChanged };
};

interface IntraTokenPart {
  changed: boolean;
  text: string;
}

const toIntraParts = (
  text: string,
  prefixLen: number,
  suffixLen: number
): IntraTokenPart[] =>
  [
    { changed: false, text: text.slice(0, prefixLen) },
    { changed: true, text: text.slice(prefixLen, text.length - suffixLen) },
    { changed: false, text: text.slice(text.length - suffixLen) },
  ].filter((part) => part.text.length > 0);

const splitIntraToken = (
  oldText: string,
  newText: string
): { newParts: IntraTokenPart[]; oldParts: IntraTokenPart[] } => {
  let prefixLen = 0;
  while (
    prefixLen < oldText.length &&
    prefixLen < newText.length &&
    oldText[prefixLen] === newText[prefixLen]
  ) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldText.length - prefixLen &&
    suffixLen < newText.length - prefixLen &&
    oldText[oldText.length - 1 - suffixLen] ===
      newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  return {
    newParts: toIntraParts(newText, prefixLen, suffixLen),
    oldParts: toIntraParts(oldText, prefixLen, suffixLen),
  };
};

const computeChangedRuns = (
  changed: readonly boolean[]
): Array<[number, number]> => {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let index = 0; index <= changed.length; index += 1) {
    if (index < changed.length && changed[index]) {
      if (start < 0) {
        start = index;
      }
    } else if (start >= 0) {
      runs.push([start, index - 1]);
      start = -1;
    }
  }
  return runs;
};

/**
 * Pairs single-token changed runs between the old and new line so the
 * renderer can refine them intra-token (faint region + strong changed
 * characters) instead of highlighting the whole token.
 */
const pairRefinements = (
  oldChanged: readonly boolean[],
  newChanged: readonly boolean[]
): { newPairs: Map<number, number>; oldPairs: Map<number, number> } => {
  const oldRuns = computeChangedRuns(oldChanged);
  const newRuns = computeChangedRuns(newChanged);
  const oldPairs = new Map<number, number>();
  const newPairs = new Map<number, number>();

  const pairCount = Math.min(oldRuns.length, newRuns.length);
  for (let pair = 0; pair < pairCount; pair += 1) {
    const [oldStart, oldEnd] = oldRuns[pair];
    const [newStart, newEnd] = newRuns[pair];
    if (oldStart === oldEnd && newStart === newEnd) {
      oldPairs.set(oldStart, newStart);
      newPairs.set(newStart, oldStart);
    }
  }

  return { newPairs, oldPairs };
};

const computeRefinedParts = (
  tokens: readonly CodeToken[],
  counterpartTokens: readonly CodeToken[],
  pairs: ReadonlyMap<number, number>
): Map<number, IntraTokenPart[]> => {
  const refined = new Map<number, IntraTokenPart[]>();
  for (const [tokenIndex, counterpartIndex] of pairs) {
    const token = tokens[tokenIndex];
    const counterpart = counterpartTokens[counterpartIndex];
    if (!(token && counterpart)) {
      continue;
    }
    const { oldParts } = splitIntraToken(token.text, counterpart.text);
    refined.set(tokenIndex, oldParts);
  }
  return refined;
};

const renderDiffLine = (params: {
  changed: boolean[];
  kind: "add" | "remove";
  lineNo: number;
  refinedParts: ReadonlyMap<number, IntraTokenPart[]>;
  tokens: CodeToken[];
}): string => {
  const fg = params.kind === "remove" ? DIFF_REMOVE_FG : DIFF_ADD_FG;
  const faintBg =
    params.kind === "remove" ? DIFF_REMOVE_FAINT_BG : DIFF_ADD_FAINT_BG;
  const prefix = params.kind === "remove" ? "-" : "+";

  const segments = params.tokens.flatMap((token, index) => {
    if (!params.changed[index]) {
      return [`${token.color}${token.text}${ANSI_RESET}`];
    }

    // Whitespace never takes the strong highlight; even when it changed it
    // drops to the faint region tint, so only real characters glow.
    if (token.text.trim().length === 0) {
      return [`${faintBg}${token.color}${token.text}${ANSI_RESET}`];
    }

    const parts = params.refinedParts.get(index);
    if (parts === undefined) {
      return [
        `${fg}${DIFF_INVERSE_ON}${token.text}${DIFF_INVERSE_OFF}${ANSI_RESET}`,
      ];
    }

    return parts.map((part) =>
      part.changed
        ? `${fg}${DIFF_INVERSE_ON}${part.text}${DIFF_INVERSE_OFF}${ANSI_RESET}`
        : `${faintBg}${token.color}${part.text}${ANSI_RESET}`
    );
  });

  return `${fg}${prefix}${params.lineNo} ${ANSI_RESET}${segments.join("")}`;
};

/**
 * LCS over whole line texts; returns index pairs of lines that are
 * identical on both sides of the diff, in order.
 */
const matchIdenticalLines = (
  oldLines: readonly string[],
  newLines: readonly string[]
): Array<[number, number]> => {
  const rows = oldLines.length;
  const cols = newLines.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0)
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        oldLines[i] === newLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
};

const renderEditedSide = (
  line: DiffLine,
  kind: "add" | "remove",
  counterpart: DiffLine | undefined
): string => {
  const tokens = tokenizeCode(line.text);
  if (counterpart === undefined) {
    return renderDiffLine({
      changed: tokens.map(() => true),
      kind,
      lineNo: line.lineNo,
      refinedParts: new Map(),
      tokens,
    });
  }
  const counterpartTokens = tokenizeCode(counterpart.text);
  const { oldChanged, newChanged } = markChangedTokens(
    tokens.map((token) => token.text),
    counterpartTokens.map((token) => token.text)
  );
  const { oldPairs } = pairRefinements(oldChanged, newChanged);
  const refinedParts = computeRefinedParts(tokens, counterpartTokens, oldPairs);
  return renderDiffLine({
    changed: oldChanged,
    kind,
    lineNo: line.lineNo,
    refinedParts,
    tokens,
  });
};

const renderContextLine = (line: DiffLine): string =>
  `${DIFF_CONTEXT_DIM} ${line.lineNo} ${ANSI_RESET}${tokenizeCode(line.text)
    .map((token) => `${token.color}${token.text}${ANSI_RESET}`)
    .join("")}`;

const renderDiffGroup = (lines: readonly DiffLine[]): string => {
  const removed = lines.filter((line) => line.kind === "remove");
  const added = lines.filter((line) => line.kind === "add");

  // Lines that are identical on both sides carry no edit; they collapse
  // into a single dim context row no matter how far the edit shifted them.
  const identical = matchIdenticalLines(
    removed.map((line) => line.text),
    added.map((line) => line.text)
  );
  const matchedOld = new Set(identical.map(([oldIndex]) => oldIndex));
  const matchedNew = new Set(identical.map(([, newIndex]) => newIndex));

  // Only genuinely edited lines get a counterpart for token-level refinement.
  const unmatchedOld = removed.filter((_, index) => !matchedOld.has(index));
  const unmatchedNew = added.filter((_, index) => !matchedNew.has(index));
  const counterpartOf = new Map<DiffLine, DiffLine>();
  for (const [index, oldLine] of unmatchedOld.entries()) {
    const newLine = unmatchedNew[index];
    if (newLine !== undefined) {
      counterpartOf.set(oldLine, newLine);
      counterpartOf.set(newLine, oldLine);
    }
  }

  const events: Array<{ key: number; text: string }> = [];
  for (const [, newIndex] of identical) {
    const line = added[newIndex];
    if (line !== undefined) {
      events.push({ key: line.lineNo, text: renderContextLine(line) });
    }
  }
  for (const [index, oldLine] of removed.entries()) {
    if (matchedOld.has(index)) {
      continue;
    }
    const counterpart = counterpartOf.get(oldLine);
    const rows = [
      renderEditedSide(oldLine, "remove", counterpart),
      ...(counterpart === undefined
        ? []
        : [renderEditedSide(counterpart, "add", oldLine)]),
    ];
    events.push({ key: oldLine.lineNo, text: rows.join("\n") });
  }
  for (const [index, newLine] of added.entries()) {
    if (matchedNew.has(index) || counterpartOf.has(newLine)) {
      continue;
    }
    events.push({
      key: newLine.lineNo,
      text: renderEditedSide(newLine, "add", undefined),
    });
  }

  return events
    .sort((left, right) => left.key - right.key)
    .map((event) => event.text)
    .join("\n");
};

const groupStartLine = (group: readonly DiffLine[]): number =>
  Math.min(...group.map((line) => line.lineNo));

const summarizeEdits = (edits: EditOp[]): string =>
  edits.map(formatEditHunk).join("\n\n");

const looksLikeHeaderLine = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("====") &&
    (trimmed.endsWith("====") || trimmed.includes("===="))
  );
};

const buildDisplayContent = (params: {
  content: string;
  stripHeaders: boolean;
}): string => {
  const lines = normalizedLines(params.content);
  if (!params.stripHeaders) {
    return lines.join("\n");
  }
  const filtered: string[] = [];
  let headerRun = 0;
  for (const line of lines) {
    if (looksLikeHeaderLine(line)) {
      headerRun += 1;
      continue;
    }
    if (headerRun > 0 && line.trim().length === 0) {
      continue;
    }
    headerRun = 0;
    filtered.push(line);
  }
  return filtered.join("\n");
};

const getReadHeaderSuffix = (input: Record<string, unknown>): string => {
  const parts: string[] = [];
  if (numberField(input, "offset") !== undefined) {
    parts.push(`offset: ${numberField(input, "offset")}`);
  }
  if (numberField(input, "limit") !== undefined) {
    parts.push(`limit: ${numberField(input, "limit")}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
};

const renderReadFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  if (renderToolError(view, "read")) {
    return;
  }

  const outputText = typeof output === "string" ? output : undefined;
  const isDirectory = outputText?.startsWith("OK - directory") === true;
  const header = `**read${isDirectory ? " dir" : ""}** \`${path}\`${getReadHeaderSuffix(input)}`;

  if (outputText === undefined) {
    view.setPrettyBlock(header, "");
    return;
  }

  const lines = normalizedLines(outputText);
  if (isDirectory) {
    view.setPrettyBlock(header, lines.slice(2).join("\n"), {
      useBackground: false,
    });
    return;
  }

  // "OK - file", "path:", "file_hash:", "lines:" precede the hashline body.
  view.setPrettyBlock(
    header,
    highlightCode(stripHashlineAnchors(lines.slice(4).join("\n")))
  );
};

const renderWriteFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  const content = stringField(input, "content");
  if (!(path && content !== undefined)) {
    return;
  }
  if (renderToolError(view, "write")) {
    return;
  }

  view.setPrettyBlock(
    `**write** \`${path}\``,
    typeof output === "string" && output.startsWith("OK - wrote file")
      ? buildDisplayContent({ content, stripHeaders: true })
      : ""
  );
};

const renderEditFile = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  if (renderToolError(view, "edit")) {
    return;
  }

  const diffGroups =
    typeof output === "string" ? parseDiffSection(output) : undefined;
  if (diffGroups !== undefined) {
    // Present hunks in file order regardless of the model's edits order.
    const sortedGroups = [...diffGroups].sort(
      (left, right) => groupStartLine(left) - groupStartLine(right)
    );
    view.setPrettyBlock(
      `**edit** \`${path}\``,
      sortedGroups.map(renderDiffGroup).join("\n\n"),
      { useBackground: false }
    );
    return;
  }

  const editsValue = input.edits;
  const edits = Array.isArray(editsValue) ? editsValue.filter(isEditOp) : [];
  const body = edits.length > 0 ? summarizeEdits(edits) : "";

  view.setPrettyBlock(`**edit** \`${path}\``, body, { useBackground: false });
};

const renderDeleteFile = (view: BaseToolCallView, input: unknown): void => {
  if (!isRecord(input)) {
    return;
  }
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  if (renderToolError(view, "delete")) {
    return;
  }
  view.setPrettyBlock(`**delete** \`${path}\``, "");
};

const renderGlobFiles = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const pattern = stringField(input, "pattern");
  if (!pattern) {
    return;
  }
  if (renderToolError(view, "glob")) {
    return;
  }

  const path = stringField(input, "path");
  const header = `**glob** \`${pattern}\`${path ? ` (path: ${path})` : ""}`;

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(header, "");
    return;
  }

  const lines = normalizedLines(output);
  view.setPrettyBlock(header, lines.slice(1).join("\n"), {
    useBackground: false,
  });
};

const renderGrepFiles = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const pattern = stringField(input, "pattern");
  if (!pattern) {
    return;
  }
  if (renderToolError(view, "grep")) {
    return;
  }

  const context: string[] = [];
  const path = stringField(input, "path");
  if (path) {
    context.push(`path: ${path}`);
  }
  const include = stringField(input, "include");
  if (include) {
    context.push(`include: ${include}`);
  }
  const header = `**grep** \`${pattern}\`${context.length > 0 ? ` (${context.join(", ")})` : ""}`;

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(header, "");
    return;
  }

  const lines = normalizedLines(output);
  view.setPrettyBlock(header, lines.slice(1).join("\n"), {
    useBackground: false,
  });
};

const renderShellExecute = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const command = stringField(input, "command");
  if (!command) {
    return;
  }
  if (renderToolError(view, "bash")) {
    return;
  }

  const displayCommand = truncateMiddle(toSingleLine(command), MAX_SINGLE_LINE);

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(`**bash** \`${displayCommand}\``, "");
    return;
  }

  const lines = normalizedLines(output);
  const isErrorOutput =
    output.startsWith("ERROR") ||
    lines[1]?.startsWith("exit_code: 0") === false;
  const exitCodeLine = lines[1]?.startsWith("exit_code: ")
    ? lines[1].slice("exit_code: ".length).trim()
    : undefined;
  const headerSuffix =
    exitCodeLine !== undefined && exitCodeLine !== "0"
      ? `  (exit ${exitCodeLine})`
      : "";
  // "OK|ERROR - ...", "exit_code:", "signal:", "stdout:" precede the body.
  const body = lines.slice(4).join("\n");

  view.setPrettyBlock(`**bash** \`${displayCommand}\`${headerSuffix}`, body, {
    isError: isErrorOutput,
  });
};

const renderWebSearch = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const query = stringField(input, "query");
  if (!query) {
    return;
  }
  if (renderToolError(view, "web_search")) {
    return;
  }

  const header = `**web_search** \`${truncateMiddle(toSingleLine(query), MAX_SINGLE_LINE)}\``;
  if (output === undefined) {
    view.setPrettyBlock(header, "");
    return;
  }
  if (!Array.isArray(output)) {
    return;
  }

  const body =
    output.length === 0
      ? "No results."
      : output
          .map((result, index) => {
            const title = stringField(result, "title");
            const url = stringField(result, "url") ?? "";
            const snippet = stringField(result, "snippet");
            const lines = [`${index + 1}. ${title ?? url}`];
            if (title && url) {
              lines.push(`   ${url}`);
            }
            if (snippet) {
              lines.push(`   ${toSingleLine(snippet)}`);
            }
            return lines.join("\n");
          })
          .join("\n\n");

  view.setPrettyBlock(header, body);
};

const renderWebFetch = (
  view: BaseToolCallView,
  input: unknown,
  output: unknown
): void => {
  if (!isRecord(input)) {
    return;
  }
  const urlsValue = input.urls;
  const urls = Array.isArray(urlsValue)
    ? urlsValue.filter((url): url is string => typeof url === "string")
    : [];
  if (urls.length === 0) {
    return;
  }
  if (renderToolError(view, "web_fetch")) {
    return;
  }

  const header =
    urls.length === 1
      ? `**web_fetch** \`${truncateMiddle(urls[0], MAX_SINGLE_LINE)}\``
      : `**web_fetch** \`${urls.length} urls\``;
  if (output === undefined) {
    view.setPrettyBlock(header, "");
    return;
  }
  if (!Array.isArray(output)) {
    return;
  }

  const body = output
    .map((result, index) => {
      const url =
        stringField(result, "finalUrl") ?? urls[index] ?? "(unknown url)";
      const title = stringField(result, "title");
      const text = stringField(result, "text") ?? "";
      const truncated = text.length > FETCH_TEXT_PREVIEW_LIMIT;
      const preview = truncated
        ? `${text.slice(0, FETCH_TEXT_PREVIEW_LIMIT)}\n… (truncated, ${text.length} chars total)`
        : text;
      return [title === undefined ? url : `${url}\n# ${title}`, preview].join(
        "\n"
      );
    })
    .join("\n\n");

  view.setPrettyBlock(header, body);
};

/**
 * Pretty per-tool renderers for the pss coding-agent tool surface.
 * Renderers claim a tool view and replace the raw JSON block with a
 * header + ANSI-background body via `BaseToolCallView.setPrettyBlock`.
 */
export function createToolRenderers(): ToolRendererMap {
  return {
    delete_file: renderDeleteFile,
    edit_file: renderEditFile,
    glob_files: renderGlobFiles,
    grep_files: renderGrepFiles,
    read_file: renderReadFile,
    shell_execute: renderShellExecute,
    web_fetch: renderWebFetch,
    web_search: renderWebSearch,
    write_file: renderWriteFile,
  };
}
