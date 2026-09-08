import {
  CURSOR_MARKER,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { composerHeightBudget } from "./composer-height";
import { ModelSelectorComponent } from "./model-selector";
import { SessionSelectorComponent } from "./session-selector";

const widths = [1, 2, 3, 24, 48, 80, 120];
const heights = [7, 8, 11, 12, 16, 17, 24, 40, 60];
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
