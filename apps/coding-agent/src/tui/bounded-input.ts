import {
  CURSOR_MARKER,
  Input,
  SelectList,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** Keep the selected row, rather than the tail of a menu, when space is scarce. */
export function selectionWindow(lines: string[], rows: number): string[] {
  const selected = lines.findIndex((line) =>
    stripTerminalSequences(line).trimStart().startsWith("→")
  );
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(rows / 2), lines.length - rows)
  );
  return lines.slice(start, start + rows);
}

/** Horizontal cursor viewport; never truncate away the IME cursor marker. */
export function cursorLine(line: string, width: number): string {
  const marker = line.indexOf(CURSOR_MARKER);
  if (marker < 0 || visibleWidth(line) <= width) {
    return truncateToWidth(line, width, "");
  }
  const before = line.slice(0, marker);
  const after = line.slice(marker + CURSOR_MARKER.length);
  const start = Math.max(0, visibleWidth(before) - width + 1);
  const prefix = sliceByColumn(before, start, width - 1, true);
  return `${prefix}${CURSOR_MARKER}${sliceByColumn(after, 0, width - visibleWidth(prefix), true)}`;
}

export class ComposerInput extends Input {
  override render(width: number): string[] {
    // pi-tui reserves two cells for "> ". At <=2 cells use an explicit
    // cursor-only mode, retaining editing/submission of the complete value.
    if (width <= 2) {
      return [this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : " "];
    }
    return super.render(width).map((line) => cursorLine(line, width));
  }
}

export class ComposerSelectList extends SelectList {
  override render(width: number): string[] {
    return super.render(width).map((line) => truncateToWidth(line, width, ""));
  }
}
