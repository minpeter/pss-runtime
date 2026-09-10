import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Spacer,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SessionIndexEntry } from "../sessions/session-index";
import { ComposerInput } from "./bounded-input";
import { composerHeightBudget } from "./composer-height";
import {
  SessionSelectorRow,
  SessionSelectorRule,
  SessionSelectorTitle,
} from "./session-selector-row";

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const MAX_VISIBLE_SESSIONS = 10;

const style = (prefix: string, text: string): string =>
  `${prefix}${text}${ANSI_RESET}`;

const clampVisibleSessions = (value: number | undefined): number =>
  Math.max(1, Math.floor(value ?? MAX_VISIBLE_SESSIONS));

export const sessionSelectorLayout = (rows: number, occupiedRows: number) => {
  const available = rows - occupiedRows;
  const compact = available < 12;
  return {
    compact,
    maxVisibleSessions: Math.max(1, available - (compact ? 3 : 9)),
  };
};

export interface SessionSelectorOptions {
  readonly compact?: boolean;
  readonly currentSessionKey: string;
  readonly initialQuery?: string;
  readonly maxVisibleSessions?: number;
  readonly onCancel: () => void;
  readonly onSelect: (sessionKey: string) => void;
  readonly sessions: readonly SessionIndexEntry[];
}

export class SessionSelectorComponent extends Container {
  #compact: boolean;
  #requestedCompact: boolean;
  #requestedMaxVisibleSessions: number;
  readonly #currentSessionKey: string;
  #filtered: readonly SessionIndexEntry[];
  readonly #listContainer = new Container();
  #maxVisibleSessions: number;
  readonly #onCancel: () => void;
  readonly #onSelect: (sessionKey: string) => void;
  readonly #searchInput = new ComposerInput();
  #selectedIndex = 0;
  readonly #sessions: readonly SessionIndexEntry[];
  #settled = false;
  #focused = false;
  #rowBudget = Number.POSITIVE_INFINITY;

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#searchInput.focused = value;
  }

  constructor(options: SessionSelectorOptions) {
    super();
    this.#compact = options.compact ?? false;
    this.#currentSessionKey = options.currentSessionKey;
    this.#maxVisibleSessions = clampVisibleSessions(options.maxVisibleSessions);
    this.#requestedCompact = this.#compact;
    this.#requestedMaxVisibleSessions = this.#maxVisibleSessions;
    this.#onCancel = options.onCancel;
    this.#onSelect = options.onSelect;
    this.#sessions = [
      ...options.sessions.filter(
        (entry) => entry.key === options.currentSessionKey
      ),
      ...options.sessions
        .filter((entry) => entry.key !== options.currentSessionKey)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    ];
    this.#filtered = this.#sessions;
    this.#searchInput.handleInput(options.initialQuery ?? "");
    this.#searchInput.onSubmit = () => this.#confirmSelection();
    this.#searchInput.onEscape = () => this.#cancel();
    this.#rebuildLayout();
    this.#applyFilter(this.#searchInput.getValue());
  }

  setLayout(maxVisibleSessions: number, compact: boolean): void {
    this.#requestedMaxVisibleSessions =
      clampVisibleSessions(maxVisibleSessions);
    this.#requestedCompact = compact;
    this.#applyLayout();
  }

  #applyLayout(): void {
    // Title, search and scroll info reserve three rows; standard decoration
    // reserves six more. Always retain at least one selected-item row.
    const nextCompact = this.#requestedCompact || this.#rowBudget < 10;
    const next = Math.min(
      this.#requestedMaxVisibleSessions,
      this.#rowBudget - (nextCompact ? 3 : 9)
    );
    if (next === this.#maxVisibleSessions && nextCompact === this.#compact) {
      return;
    }
    this.#maxVisibleSessions = next;
    this.#compact = nextCompact;
    this.#rebuildLayout();
    this.#updateList();
  }

  setComposerHeight(terminalRows: number): void {
    this.#rowBudget = composerHeightBudget(terminalRows) - 1;
    this.#applyLayout();
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.up")) {
      this.#moveSelection(-1);
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      this.#moveSelection(1);
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      this.#confirmSelection();
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.#cancel();
      return;
    }
    this.#searchInput.handleInput(data);
    this.#applyFilter(this.#searchInput.getValue());
  }

  #rebuildLayout(): void {
    this.clear();
    if (!this.#compact) {
      this.addChild(new SessionSelectorRule());
      this.addChild(new Spacer(1));
    }
    this.addChild(new SessionSelectorTitle());
    if (!this.#compact) {
      this.addChild(new Spacer(1));
    }
    this.addChild(this.#searchInput);
    if (!this.#compact) {
      this.addChild(new Spacer(1));
    }
    this.addChild(this.#listContainer);
    if (!this.#compact) {
      this.addChild(new Spacer(1));
      this.addChild(new SessionSelectorRule());
    }
  }

  #moveSelection(delta: number): void {
    if (this.#filtered.length === 0) {
      return;
    }
    this.#selectedIndex =
      (this.#selectedIndex + delta + this.#filtered.length) %
      this.#filtered.length;
    this.#updateList();
  }

  #confirmSelection(): void {
    const selected = this.#filtered[this.#selectedIndex];
    if (selected === undefined || this.#settled) {
      return;
    }
    this.#settled = true;
    this.#onSelect(selected.key);
  }

  #cancel(): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#onCancel();
  }

  #applyFilter(query: string): void {
    this.#filtered = query
      ? fuzzyFilter(
          [...this.#sessions],
          query,
          (entry) => `${entry.name ?? ""} ${sessionKeySuffix(entry.key)}`
        )
      : this.#sessions;
    this.#selectedIndex = Math.min(
      this.#selectedIndex,
      Math.max(0, this.#filtered.length - 1)
    );
    this.#updateList();
  }

  #updateList(): void {
    this.#listContainer.clear();
    if (this.#filtered.length === 0) {
      this.#listContainer.addChild({
        invalidate() {
          return;
        },
        render: (width) => [
          truncateToWidth(style(ANSI_DIM, "  No matching sessions"), width, ""),
        ],
      });
      return;
    }
    const start = Math.max(
      0,
      Math.min(
        this.#selectedIndex - Math.floor(this.#maxVisibleSessions / 2),
        this.#filtered.length - this.#maxVisibleSessions
      )
    );
    const end = Math.min(
      start + this.#maxVisibleSessions,
      this.#filtered.length
    );
    for (let index = start; index < end; index++) {
      const entry = this.#filtered[index];
      if (entry !== undefined) {
        this.#listContainer.addChild(
          new SessionSelectorRow(
            entry,
            entry.key === this.#currentSessionKey,
            index === this.#selectedIndex,
            this.#filtered.some(
              (session) => session.key === this.#currentSessionKey
            )
          )
        );
      }
    }
    if (start > 0 || end < this.#filtered.length) {
      this.#listContainer.addChild({
        invalidate() {
          return;
        },
        render: (width) => [
          truncateToWidth(
            style(
              ANSI_DIM,
              `  (${this.#selectedIndex + 1}/${this.#filtered.length})`
            ),
            width,
            ""
          ),
        ],
      });
    }
  }
}

const sessionKeySuffix = (key: string): string => {
  const separator = key.lastIndexOf("#");
  if (separator >= 0) {
    return key.slice(separator + 1);
  }
  return key.startsWith("cwd:") ? "" : key;
};
