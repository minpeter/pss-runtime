import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sessionPrimaryLabel } from "./session-option-format";
import {
  SessionSelectorComponent,
  sessionSelectorLayout,
} from "./session-selector";
import { SessionSelectorRow } from "./session-selector-row";
import { SnapshotText } from "./snapshot-views";
import { ColdSnapshot } from "./transcript-owner";

const korean = "긴한글제목남은공간확인테스트입니다";
const entry = {
  createdAt: "",
  cwd: "/work",
  key: "cwd:/work#abcdefgh",
  name: korean,
  updatedAt: "2026-09-08T12:34:00Z",
};
const entries = Array.from({ length: 15 }, (_, index) => ({
  ...entry,
  key: `cwd:/work#id${index.toString().padStart(6, "0")}`,
  name: `item${index.toString().padStart(2, "0")}`,
}));
const plain = (rows: string[]) => rows.map(stripTerminalSequences);
const PREFIX = /^\s*→?\s*/;
const METADATA = / {2}#| {2}updated/;
const ELLIPSIS = /\.+\s*$/;
const WHITESPACE = /\s/g;

describe("responsive resume", () => {
  it.each([80, 120, 240])(
    "shows the full 34-cell title and metadata at %i columns",
    (width) => {
      const row = plain(
        new SessionSelectorRow(entry, true, true).render(width)
      )[0];
      expect(visibleWidth(korean)).toBe(34);
      expect(row).toContain(korean);
      expect(row).toContain("#abcdefgh");
      expect(row).toContain("2026-09-08 12:34");
    }
  );

  it("never shortens a title as columns are added", () => {
    for (const name of [
      korean,
      "abc".repeat(60),
      "API 한국어 日本語 mixed".repeat(6),
    ]) {
      let previous = 0;
      for (let width = 5; width <= 240; width++) {
        const row = plain(
          new SessionSelectorRow({ ...entry, name }, false, true).render(width)
        )[0];
        const title = row
          .replace(PREFIX, "")
          .split(METADATA)[0]
          .replace(ELLIPSIS, "")
          .trimEnd();
        const displayed = name.startsWith(title) ? visibleWidth(title) : 0;
        expect(displayed, `width=${width} row=${row}`).toBeGreaterThanOrEqual(
          previous
        );
        previous = displayed;
      }
    }
  });

  it("bounds selected/current rows and searchable components at every integer width", () => {
    for (let width = 1; width <= 240; width++) {
      for (const current of [false, true]) {
        for (const selected of [false, true]) {
          const rows = new SessionSelectorRow(
            { ...entry, key: "cwd:/work#한국어日本語" },
            current,
            selected
          ).render(width);
          expect(
            rows.every((row) => visibleWidth(row) <= width),
            `row width ${width}`
          ).toBe(true);
        }
      }
      const selector = new SessionSelectorComponent({
        sessions: [entry],
        currentSessionKey: entry.key,
        onCancel: vi.fn(),
        onSelect: vi.fn(),
      });
      selector.handleInput("한국");
      expect(
        selector.render(width).every((row) => visibleWidth(row) <= width),
        `component width ${width}`
      ).toBe(true);
    }
  });

  it.each([80, 120])(
    "uses the supplied 15-entry height budget at width %i",
    (width) => {
      const selector = new SessionSelectorComponent({
        sessions: entries,
        currentSessionKey: "",
        maxVisibleSessions: 15,
        onCancel: vi.fn(),
        onSelect: vi.fn(),
      });
      const rows = plain(selector.render(width));
      expect(
        entries.every((item) => rows.some((row) => row.includes(item.name)))
      ).toBe(true);
    }
  );

  it("keeps selection and search across shrinking and growing layouts", () => {
    const onSelect = vi.fn();
    const selector = new SessionSelectorComponent({
      sessions: entries,
      currentSessionKey: "",
      maxVisibleSessions: 15,
      initialQuery: "item",
      onCancel: vi.fn(),
      onSelect,
    });
    for (let i = 0; i < 14; i++) {
      selector.handleInput("\x1b[B");
    }
    selector.setLayout(1, true);
    expect(
      plain(selector.render(24)).some((row) => row.includes("→ item14"))
    ).toBe(true);
    selector.setLayout(30, false);
    expect(
      plain(selector.render(120)).some((row) => row.includes("→ item14"))
    ).toBe(true);
    selector.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(entries[14].key);
  });

  it("keeps autocomplete labels compact", () => {
    expect(visibleWidth(sessionPrimaryLabel(entry))).toBe(30);
  });

  it.each([24, 40, 60])(
    "accounts for occupied rows and selector chrome at height %i",
    (height) => {
      for (const occupied of [4, 10, 15]) {
        const layout = sessionSelectorLayout(height, occupied);
        const selector = new SessionSelectorComponent({
          sessions: entries,
          currentSessionKey: "",
          ...layout,
          onCancel: vi.fn(),
          onSelect: vi.fn(),
        });
        expect(selector.render(80).length + occupied).toBeLessThanOrEqual(
          height
        );
        if (height >= 40) {
          expect(
            plain(selector.render(80)).filter((row) => row.includes("item"))
          ).toHaveLength(15);
        }
      }
    }
  );

  it.each([{ sessions: [] }, { sessions: [entry] }])(
    "handles empty and single-entry lists",
    ({ sessions }) => {
      const onSelect = vi.fn();
      const selector = new SessionSelectorComponent({
        sessions,
        currentSessionKey: "",
        maxVisibleSessions: 1,
        compact: true,
        onCancel: vi.fn(),
        onSelect,
      });
      selector.handleInput("\x1b[B");
      selector.handleInput("\r");
      expect(onSelect).toHaveBeenCalledTimes(sessions.length);
      expect(selector.render(24).length).toBeLessThanOrEqual(3);
    }
  );

  it("keeps HOT and COLD two-line CJK blocks bounded on every resize", () => {
    const source = `${korean}\nmodel · /work/한국어/日本語`;
    const view = new SnapshotText(
      source,
      1,
      1,
      (text) => `\x1b[48;5;235m${text}\x1b[0m`
    );
    const cold = ColdSnapshot.capture(view, 80);
    for (let width = 1; width <= 240; width++) {
      for (const component of [view, cold]) {
        const rows = component.render(width);
        expect(
          rows.every((row) => visibleWidth(row) <= width),
          `block width ${width}`
        ).toBe(true);
        if (width > 1) {
          expect(plain(rows).join("").replace(WHITESPACE, "")).toBe(
            source.replace(WHITESPACE, "")
          );
        }
      }
    }
  });
});
