import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { StartupHeaderView } from "./startup-header";
import { ColdSnapshot } from "./transcript-owner";

const widths = [1, 2, 3, 4, 7, 24, 80];
const compact = (rows: string[]) =>
  rows.map(stripTerminalSequences).join("").replaceAll(/\s/g, "");

describe("startup header CJK boundaries", () => {
  it.each(["한국어", "item-99-한국어-mixed"])(
    "preserves %s through pulse, settle and frozen resize",
    (model) => {
      const view = new StartupHeaderView(["QA"], ["local"], "local");
      view.setModel(model, true);
      for (const pulsing of [true, false]) {
        if (!pulsing) {
          view.settle();
        }
        const cold = ColdSnapshot.capture(view, 80);
        const original = new Map(
          widths.map((width) => [width, cold.render(width)])
        );
        for (const width of widths) {
          for (const component of [view, cold]) {
            const rows = component.render(width);
            expect(rows.every((line) => visibleWidth(line) <= width)).toBe(
              true
            );
            expect(compact(rows)).toBe(
              `QA${width === 1 ? model.replaceAll(/[한국어]/g, "?") : model}`
            );
            expect(rows.some((line) => line.includes("\x1b[47m"))).toBe(
              pulsing
            );
            // Settled model reads in the lime accent; the pulse replaces it.
            expect(rows.some((line) => line.includes("\x1b[38;5;118m"))).toBe(
              !pulsing
            );
          }
        }
        view.setModel("CHANGED", !pulsing);
        for (const width of widths) {
          expect(cold.render(width)).toEqual(original.get(width));
        }
        view.setModel(model, pulsing);
      }
      const wide = view.render(80).map(stripTerminalSequences);
      expect(wide).toHaveLength(1);
      expect(wide[0]).toBe(` QA  ${model} `);
    }
  );
});
