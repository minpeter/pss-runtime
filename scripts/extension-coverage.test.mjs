import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EXTENSIONS = [
  ["latex", { branches: 60, functions: 75, lines: 70, statements: 70 }],
  ["mermaid", { branches: 78, functions: 88, lines: 88, statements: 88 }],
  ["web", { branches: 60, functions: 82, lines: 75, statements: 75 }],
];

async function coverageConfig(name) {
  const module = await import(`../extensions/${name}/vitest.config.ts`);
  return module.default.test.coverage;
}

function hasCompletePositiveThresholds(thresholds) {
  const keys = ["branches", "functions", "lines", "statements"];
  return keys.every(
    (key) => typeof thresholds[key] === "number" && thresholds[key] > 0
  );
}

describe("extension coverage gates", () => {
  it.each(EXTENSIONS)(
    "pins meaningful %s coverage floors",
    async (name, floors) => {
      const coverage = await coverageConfig(name);
      expect(coverage.provider).toBe("v8");
      expect(coverage.include).toEqual(["src/**/*.ts"]);
      expect(coverage.exclude).toContain("src/**/*.test.ts");
      expect(coverage.thresholds).toEqual(floors);

      const manifest = JSON.parse(
        readFileSync(`extensions/${name}/package.json`, "utf8")
      );
      expect(manifest.scripts["test:coverage"]).toBe("vitest run --coverage");
    }
  );

  it("rejects a missing or zero threshold in the test oracle", () => {
    const valid = { branches: 60, functions: 75, lines: 70, statements: 70 };
    for (const mutation of [
      { ...valid, branches: 0 },
      { branches: 60, functions: 75, lines: 70 },
    ]) {
      expect(hasCompletePositiveThresholds(mutation)).toBe(false);
    }
  });
});
