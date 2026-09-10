import {
  CURSOR_MARKER,
  Editor,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { cursorLine, selectionWindow } from "./bounded-input";
import { composerHeightBudget } from "./composer-height";

// Local framing tags never reach the terminal. Keep pi-tui's own layout,
// paste-marker handling and editing semantics; budget its text and menu
// independently, before assembling borders, content and autocomplete.
const BORDER = "\x00composer-border\x00";

export class ComposerEditor extends Editor {
  override render(width: number): string[] {
    const borderColor = this.borderColor;
    const focused = this.focused;
    let source: string[];
    try {
      this.borderColor = (text) => BORDER + borderColor(text);
      this.focused = true;
      source = super.render(width);
    } finally {
      this.borderColor = borderColor;
      this.focused = focused;
    }
    const bottom = source.findIndex(
      (line, index) => index > 0 && line.startsWith(BORDER)
    );
    const content = source.slice(1, bottom);
    const menu = source.slice(bottom + 1);
    const available = composerHeightBudget(this.tui.terminal.rows) - 3;
    // A menu always leaves a text row for the cursor. Its own selected-row
    // viewport remains usable even when only one option fits.
    const menuRows = Math.min(menu.length, Math.max(0, available - 1));
    const textRows = Math.max(1, available - menuRows);
    const cursor = content.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = Math.max(
      0,
      Math.min(cursor - textRows + 1, content.length - textRows)
    );
    const above = hiddenRows(source[0], "↑") + start;
    const below =
      hiddenRows(source[bottom], "↓") +
      Math.max(0, content.length - start - textRows);
    const border = (direction: string, count: number) =>
      borderColor(
        count > 0
          ? truncateToWidth(
              `${direction} ${count} more ${"─".repeat(width)}`,
              width,
              ""
            )
          : "─".repeat(width)
      );
    return [
      border("↑", above),
      ...content.slice(start, start + textRows).map((line) => {
        const bounded = cursorLine(line, width);
        return focused ? bounded : bounded.replace(CURSOR_MARKER, "");
      }),
      border("↓", below),
      ...selectionWindow(menu, menuRows).map((line) =>
        truncateToWidth(line.trimStart(), width, "")
      ),
    ];
  }
}

// pi-tui 0.84's scroll borders encode the already-hidden part of its text
// viewport. Include that count when applying our smaller, complete budget.
function hiddenRows(line: string, direction: string): number {
  const match = stripTerminalSequences(line).match(
    new RegExp(`${direction} (\\d+) more`)
  );
  return match ? Number(match[1]) : 0;
}
