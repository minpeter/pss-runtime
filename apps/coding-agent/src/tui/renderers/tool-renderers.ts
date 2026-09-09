import type { BaseToolCallView, ToolRendererMap } from "../tool-call-view";
import {
  renderDeleteFile,
  renderEditFile,
  renderReadFile,
  renderWriteFile,
} from "./file";
import { formatGrepMatches } from "./grep-format";
import {
  formatGlobHeader,
  formatGrepHeader,
  formatShellHeader,
  isRecord,
  normalizedLines,
  renderToolError,
  stringField,
  strippedLines,
} from "./utils";

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

  const header = formatGlobHeader(pattern, input);

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

  const header = formatGrepHeader(pattern, input);

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(header, "");
    return;
  }

  const lines = normalizedLines(output);
  view.setPrettyBlock(header, formatGrepMatches(lines.slice(1), pattern), {
    allowAnsi: true,
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

  if (typeof output !== "string" || output.length === 0) {
    view.setPrettyBlock(formatShellHeader(command), "");
    return;
  }

  const lines = strippedLines(output);
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

  view.setPrettyBlock(
    `${formatShellHeader(command)}${headerSuffix}`,
    body.trim() ? body : "(No output)",
    { isError: isErrorOutput }
  );
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
    write_file: renderWriteFile,
  };
}
