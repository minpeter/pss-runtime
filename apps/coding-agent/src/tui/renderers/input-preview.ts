import { sanitizeTerminalText } from "../terminal-safety";
import { highlightCode } from "./highlight";
import {
  formatEditHeader,
  formatGlobHeader,
  formatGrepHeader,
  formatReadHeader,
  formatShellHeader,
  formatWriteHeader,
  isRecord,
  normalizedLines,
  stringField,
} from "./utils";

const ANSI_GREEN = "\x1b[32m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

/**
 * A tool-specific preview of arguments that are still streaming, or that were
 * interrupted before execution. Previews never claim a result: bodies only
 * restate fields the model actually sent.
 */
export interface ToolInputPreview {
  allowAnsi?: boolean;
  body: string;
  header: string;
  useBackground?: boolean;
}

export interface ToolInputPreviewMap {
  [toolName: string]: (input: unknown) => ToolInputPreview | undefined;
}

/**
 * Fields the header and body already show. Anything else the model streamed is
 * appended as a dim footnote so a preview never silently drops an argument.
 */
const withExtraFields = (
  preview: ToolInputPreview,
  input: unknown,
  shown: readonly string[]
): ToolInputPreview => {
  if (!isRecord(input)) {
    return preview;
  }
  const extras = Object.entries(input)
    .filter(([key]) => !shown.includes(key))
    .map(
      ([key, value]) =>
        `${ANSI_DIM}${sanitizeTerminalText(`${key}: ${describeField(value)}`)}${ANSI_RESET}`
    );
  if (extras.length === 0) {
    return preview;
  }
  const extraBlock = extras.join("\n");
  return {
    ...preview,
    allowAnsi: true,
    body: preview.body ? `${preview.body}\n\n${extraBlock}` : extraBlock,
    // A footnote alone is metadata, not a body: it reads as a stray filled
    // stub against the gray block background used for real content.
    useBackground: preview.body ? preview.useBackground : false,
  };
};

const describeField = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const createWriteFilePreview = (): ToolInputPreviewMap[string] => {
  // Highlighting is line-local; retain only the current view, not past inputs.
  let previousLines: string[] = [];
  let highlightedLines: string[] = [];
  return (input) => {
    const path = stringField(input, "path");
    if (!path) {
      return;
    }
    const content = isRecord(input) ? input.content : undefined;
    const lines = typeof content === "string" ? normalizedLines(content) : [];
    highlightedLines = lines.map((line, index) =>
      line === previousLines[index]
        ? highlightedLines[index]
        : highlightCode(line)
    );
    previousLines = lines;
    return withExtraFields(
      {
        allowAnsi: true,
        body: highlightedLines.join("\n"),
        header: formatWriteHeader(path),
      },
      input,
      ["path", "content"]
    );
  };
};

const previewReadFile = (input: unknown): ToolInputPreview | undefined => {
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  // File contents are only known after execution; the header carries the range.
  return withExtraFields(
    { body: "", header: formatReadHeader(path, input) },
    input,
    ["path", "offset", "limit"]
  );
};

const anchorLabel = (edit: Record<string, unknown>): string | undefined => {
  const op = stringField(edit, "op");
  const target = stringField(edit, "target");
  const first = stringField(edit, "first");
  const last = stringField(edit, "last");
  const range = first && last ? `${first}..${last}` : (target ?? first ?? last);
  if (!(op || range)) {
    return;
  }
  return [op, range].filter(Boolean).join(" ");
};

const proposedLines = (edit: Record<string, unknown>): string[] => {
  const content = edit.new_content;
  if (typeof content === "string") {
    return normalizedLines(content);
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((line): line is string => typeof line === "string")
    .flatMap((line) => normalizedLines(line));
};

const previewEdit = (edit: unknown): string | undefined => {
  if (!isRecord(edit)) {
    return;
  }
  const label = anchorLabel(edit);
  const lines = proposedLines(edit).map(
    (line) => `${ANSI_GREEN}${line}${ANSI_RESET}`
  );
  const head =
    label === undefined
      ? undefined
      : `${ANSI_DIM}${sanitizeTerminalText(label)}${ANSI_RESET}`;
  const block = [head, ...lines].filter((line) => line !== undefined);
  return block.length > 0 ? block.join("\n") : undefined;
};

const previewEditFile = (input: unknown): ToolInputPreview | undefined => {
  const path = stringField(input, "path");
  if (!path) {
    return;
  }
  // Proposed replacements only: the real diff needs the file on disk, which
  // an interrupted call never touched.
  const edits =
    isRecord(input) && Array.isArray(input.edits) ? input.edits : [];
  const body = edits
    .map(previewEdit)
    .filter((block): block is string => block !== undefined)
    .join("\n\n");
  return withExtraFields(
    {
      allowAnsi: true,
      body,
      header: formatEditHeader(path),
      useBackground: false,
    },
    input,
    ["path", "edits", "expected_file_hash"]
  );
};

const previewShellExecute = (input: unknown): ToolInputPreview | undefined => {
  const command = stringField(input, "command");
  if (!command) {
    return;
  }
  // stdout/exit status exist only after the executor runs.
  return withExtraFields(
    { body: "", header: formatShellHeader(command) },
    input,
    ["command"]
  );
};

const previewGlobFiles = (input: unknown): ToolInputPreview | undefined => {
  const pattern = stringField(input, "pattern");
  if (!pattern) {
    return;
  }
  return withExtraFields(
    { body: "", header: formatGlobHeader(pattern, input) },
    input,
    ["pattern", "path"]
  );
};

const previewGrepFiles = (input: unknown): ToolInputPreview | undefined => {
  const pattern = stringField(input, "pattern");
  if (!pattern) {
    return;
  }
  return withExtraFields(
    { body: "", header: formatGrepHeader(pattern, input) },
    input,
    ["pattern", "path", "include"]
  );
};

/**
 * Per-tool previews for arguments that have not executed. Shapes are always
 * partial here, so every preview reads defensively and falls back to the
 * generic field preview by returning `undefined`.
 */
export function createToolInputPreviews(): ToolInputPreviewMap {
  return {
    delete_file: (input) => {
      const path = stringField(input, "path");
      return path
        ? withExtraFields(
            { body: "", header: `**delete** \`${path}\`` },
            input,
            ["path"]
          )
        : undefined;
    },
    edit_file: previewEditFile,
    glob_files: previewGlobFiles,
    grep_files: previewGrepFiles,
    read_file: previewReadFile,
    shell_execute: previewShellExecute,
    write_file: createWriteFilePreview(),
  };
}
