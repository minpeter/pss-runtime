import {
  CURSOR_MARKER,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { composerHeightBudget } from "./composer-height";
import { ModelSelectorComponent } from "./model-selector";
import {
  SessionSelectorComponent,
  sessionSelectorLayout,
} from "./session-selector";

const widths = [1, 2, 3, 24, 48, 80, 120];
const heights = [7, 8, 11, 12, 16, 17, 24, 40, 60];
const ITEM_ROW = /^\s*(?:→ | {2})item-/u;
const ids = Array.from(
  { length: 100 },
  (_, i) => `item-${String(i).padStart(2, "0")}-${"한국어".repeat(30)}`
);

function fixture(kind: "model" | "session", count: number) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const items = ids.slice(0, count);
  const selector =
    kind === "model"
      ? new ModelSelectorComponent({
          currentModelId: ids[0],
          modelIds: items,
          onSelect,
          onCancel,
        })
      : new SessionSelectorComponent({
          currentSessionKey: ids[0],
          sessions: items.map((key) => ({
            key,
            name: key,
            cwd: "/tmp",
            createdAt: "2026-09-08T00:00:00Z",
            updatedAt: "2026-09-08T00:00:00Z",
          })),
          onSelect,
          onCancel,
        });
  selector.focused = true;
  return { selector, onSelect, onCancel };
}

describe.each(["model", "session"] as const)("complete %s composer", (kind) => {
  it("retains caller limits separately from the transient composer budget", () => {
    const { selector } = fixture(kind, 100);
    selector.setLayout(2, true);
    selector.handleInput("\x1b[A");
    for (const height of [120, 7, 120]) {
      selector.setComposerHeight(height);
      const rendered = selector.render(80);
      const itemRows = rendered.filter((line) =>
        ITEM_ROW.test(stripTerminalSequences(line))
      );
      expect(itemRows).toHaveLength(height === 7 ? 1 : 2);
      expect(rendered.find((line) => line.includes("→"))).toContain("item-99");
    }
  });

  it.each([0, 1, 100])("bounds a %d-item catalog through resize", (count) => {
    const { selector, onSelect, onCancel } = fixture(kind, count);
    selector.handleInput("\x1b[A");
    for (const height of [...heights, ...[...heights].reverse()]) {
      selector.setComposerHeight(height);
      // A caller's full-screen layout must not override the complete cap.
      selector.setLayout(100, false);
      for (const width of widths) {
        const rows = selector.render(width);
        expect(rows.length + 1).toBeLessThanOrEqual(
          composerHeightBudget(height)
        );
        expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(rows.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
        const selected = rows.find((line) =>
          stripTerminalSequences(line).trimStart().startsWith("→")
        );
        expect(selected !== undefined).toBe(count > 0);
        if (count > 0 && width >= 24) {
          expect(selected).toContain(
            `item-${String(count - 1).padStart(2, "0")}`
          );
        }
        expect(selector.render(width)).toEqual(rows);
      }
    }
    selector.handleInput("\r");
    if (count > 0) {
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(ids[count - 1]);
    } else {
      expect(onSelect).not.toHaveBeenCalled();
      selector.handleInput("\x1b");
      expect(onCancel).toHaveBeenCalledOnce();
    }
  });

  it.each(heights)(
    "retains search and cancel semantics at height %d",
    (height) => {
      for (const width of widths) {
        const { selector, onSelect, onCancel } = fixture(kind, 100);
        selector.setComposerHeight(height);
        selector.handleInput("item-99");
        const rows = selector.render(width);
        expect(rows.length + 1).toBeLessThanOrEqual(
          composerHeightBudget(height)
        );
        expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(rows.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
        selector.handleInput("\r");
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(ids[99]);
        expect(onCancel).not.toHaveBeenCalled();
        const cancelled = fixture(kind, 100);
        cancelled.selector.setComposerHeight(height);
        cancelled.selector.handleInput("\x1b");
        expect(cancelled.onCancel).toHaveBeenCalledOnce();
        expect(cancelled.onSelect).not.toHaveBeenCalled();
      }
    }
  );
});

it("retains a constructor model limit and an explicitly updated maximum", () => {
  const selector = new ModelSelectorComponent({
    currentModelId: ids[0],
    modelIds: ids,
    maxVisibleModels: 2,
    onCancel: vi.fn(),
    onSelect: vi.fn(),
  });
  selector.setComposerHeight(120);
  expect(
    selector.render(80).filter((line) => line.includes("item-"))
  ).toHaveLength(3);
  selector.setMaxVisibleModels(3);
  selector.setComposerHeight(7);
  selector.setComposerHeight(120);
  expect(
    selector.render(80).filter((line) => line.includes("item-"))
  ).toHaveLength(4);
});

it("combines occupied session rows with the composer cap on shrink and grow", () => {
  const { selector } = fixture("session", 100);
  for (const [height, occupied] of [
    [40, 35],
    [60, 10],
    [40, 35],
  ]) {
    const layout = sessionSelectorLayout(height, occupied);
    selector.setLayout(layout.maxVisibleSessions, layout.compact);
    selector.setComposerHeight(height);
    expect(selector.render(80).length).toBeLessThanOrEqual(
      Math.min(height - occupied, composerHeightBudget(height) - 1)
    );
  }
});
