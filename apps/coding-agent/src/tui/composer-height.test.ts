import { describe, expect, it } from "vitest";
import { composerContentBudget, composerHeightBudget } from "./composer-height";

describe("shared composer height budget", () => {
  it("uses the measured editor cap and reserves composer chrome", () => {
    const cases = [
      [7, 5, 3],
      [8, 5, 3],
      [11, 5, 3],
      [12, 5, 3],
      [16, 5, 3],
      [17, 5, 3],
      [24, 7, 5],
      [40, 12, 10],
      [60, 18, 16],
    ];
    for (const [height, total, content] of cases) {
      expect(composerHeightBudget(height)).toBe(total);
      expect(composerContentBudget(height)).toBe(content);
    }
  });

  it.each([1, 2, 3, 24, 48, 80, 120])(
    "keeps a positive budget at height %d",
    (height) => {
      expect(composerContentBudget(height)).toBeGreaterThan(0);
    }
  );
});
