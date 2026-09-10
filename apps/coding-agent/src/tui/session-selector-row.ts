import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  sessionDisplayKey,
  sessionDisplayTitle,
  sessionUpdatedLabel,
} from "../sessions/session-display";
import type { SessionIndexEntry } from "../sessions/session-index";
import { ACCENT_LIME, ACCENT_ORANGE } from "./palette";
import { sanitizeTerminalText } from "./terminal-safety";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";
const ANSI_GRAY = "\x1b[90m";
const COLUMN_GAP = "  ";

const style = (prefix: string, text: string): string =>
  `${prefix}${text}${ANSI_RESET}`;

export class SessionSelectorRule implements Component {
  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    return [style(ANSI_GRAY, "─".repeat(Math.max(0, width)))];
  }
}

export class SessionSelectorTitle implements Component {
  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    const title = `${style(ANSI_BOLD, "Resume a session")} ${style(ANSI_DIM, "— type to search · enter to resume · esc to cancel")}`;
    return [truncateToWidth(title, width)];
  }
}

export class SessionSelectorRow implements Component {
  readonly #current: boolean;
  readonly #entry: SessionIndexEntry;
  readonly #selected: boolean;
  readonly #reserveCurrent: boolean;

  constructor(
    entry: SessionIndexEntry,
    current: boolean,
    selected: boolean,
    reserveCurrent = current
  ) {
    this.#entry = entry;
    this.#current = current;
    this.#selected = selected;
    this.#reserveCurrent = reserveCurrent;
  }

  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    const currentMarker = this.#current ? "✓" : "";
    if (width <= 5) {
      return [
        style(
          ACCENT_ORANGE,
          truncateToWidth(this.#selected ? "→" : currentMarker, width)
        ),
      ];
    }
    const prefix = this.#selected ? "→ " : "  ";
    const suffix = this.#reserveCurrent ? ` ${currentMarker || " "}` : "";
    const availableWidth = Math.max(
      0,
      width - 1 - visibleWidth(prefix) - visibleWidth(suffix)
    );
    const updated = sessionUpdatedLabel(this.#entry);
    const updatedWidth = visibleWidth(updated);
    const title = sanitizeTerminalText(sessionDisplayTitle(this.#entry));
    const key = truncateToWidth(
      sanitizeTerminalText(sessionDisplayKey(this.#entry)),
      9
    );
    const titleWidth = visibleWidth(title);
    // Keep titles monotonic across metadata thresholds. Right-anchor the key
    // even when a row has room for a timestamp and its neighbour does not.
    const showKey = availableWidth >= titleWidth + 2 + 9;
    const showUpdated = availableWidth >= titleWidth + 2 + 9 + 2 + updatedWidth;
    const labelWidth =
      availableWidth -
      (showKey ? 11 : 0) -
      (showUpdated ? 2 + updatedWidth : 0);
    const label = truncateToWidth(title, labelWidth);
    const paddedLabel = `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}`;
    const content = `${paddedLabel}${showUpdated ? `${COLUMN_GAP}${updated}` : ""}${showKey ? `${COLUMN_GAP}${key}${" ".repeat(9 - visibleWidth(key))}` : ""}`;
    const line = `${prefix}${content}`;
    return [
      this.#selected
        ? `${style(ACCENT_ORANGE, ` ${line}`)}${style(ACCENT_LIME, suffix)}`
        : ` ${line}${style(ACCENT_LIME, suffix)}`,
    ];
  }
}
