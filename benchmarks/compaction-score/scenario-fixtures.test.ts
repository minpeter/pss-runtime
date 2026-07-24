import { estimateModelMessagesTokens } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";

describe("benchmark scenario registry", () => {
  it("covers baseline, lifecycle, and boundary-noise families", () => {
    expect(BENCHMARK_SCENARIOS).toEqual([
      "baseline",
      "lifecycle",
      "boundary-noise",
    ]);
  });

  it.each(BENCHMARK_SCENARIOS)(
    "%s has increasing tool-safe compaction boundaries",
    (scenario) => {
      const fixture = buildScenarioFixture(scenario, `invariant-${scenario}`);

      expect(fixture.scenario).toBe(scenario);
      expect(fixture.compactionEnds.length).toBeGreaterThan(0);
      expect(fixture.compactionEnds).toEqual(
        [...fixture.compactionEnds].sort((left, right) => left - right)
      );
      for (const end of fixture.compactionEnds) {
        expect(fixture.messages[end - 1]?.role).toBe("assistant");
        expect(fixture.messages[end]?.role).toBe("user");
      }
    }
  );

  it("lifecycle chains two summaries across corrections and retractions", () => {
    const fixture = buildScenarioFixture("lifecycle", "lifecycle-invariant");
    const categories = new Set(
      fixture.questions.map(({ category }) => category)
    );

    expect(fixture.compactionEnds).toHaveLength(2);
    for (const category of [
      "constraint-retention",
      "file-state",
      "hallucination-resistance",
      "negative-knowledge",
      "temporal-resolution",
    ] as const) {
      expect(categories.has(category)).toBe(true);
    }
  });

  it("boundary-noise creates real budget pressure around tool-only facts", () => {
    const fixture = buildScenarioFixture("boundary-noise", "noise-invariant");
    const end = fixture.compactionEnds.at(-1) ?? 0;
    const prefixTokens = estimateModelMessagesTokens(
      fixture.messages.slice(0, end)
    );

    expect(prefixTokens).toBeGreaterThan(5000);
    expect(
      fixture.questions.some(({ category }) => category === "boundary-recall")
    ).toBe(true);
  });
});
