import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkflows } from "./report-hygiene.mjs";
import { reportTool } from "./report-paths.mjs";
import { gitCheckIgnored, gitTracked } from "./test-fixtures.mjs";
import {
  normalizeTiming,
  timingArtifactProblems,
  timingCiProblems,
} from "./test-timing.mjs";

// Test-timing invariants (VAL-SEC-024): a root `test:timing` script produces
// a machine-readable artifact at the registered report/test-timing.json path
// (gitignored, never committed), every artifact entry carries a numeric
// `duration`, and a CI workflow contains the producing step plus a bounded
// upload-artifact step. All checks are static or pure; the one producer run
// used as live evidence stays under .omo/evidence/.

const ROOT_PACKAGE = "package.json";

function rootScripts() {
  return JSON.parse(readFileSync(ROOT_PACKAGE, "utf8")).scripts ?? {};
}

function vitestFixture(durations) {
  return {
    numTotalTests: durations.length,
    testResults: [
      {
        name: "scripts/example.test.mjs",
        status: "passed",
        assertionResults: durations.map((duration, index) => ({
          fullName: `suite > case ${index}`,
          status: duration === null ? "skipped" : "passed",
          ...(duration === null ? {} : { duration }),
        })),
      },
    ],
  };
}

const CI_WORKFLOW = (runSteps, withBlock) => `on: push
jobs:
  checks:
    steps:
${runSteps
  .map((run) => `      - run: ${run}\n`)
  .join("")}      - uses: actions/upload-artifact@v7
        with:
${withBlock}`;

describe("test timing: producer wiring (VAL-SEC-024)", () => {
  it("root package.json exposes test:timing wired to the producer", () => {
    expect(rootScripts()["test:timing"]).toContain("scripts/test-timing.mjs");
  });

  it("declares the artifact path in the registry as a CI artifact", () => {
    const tool = reportTool("test-timing");
    expect(tool.path).toBe("report/test-timing.json");
    expect(tool.ci).toBe("artifact");
    expect(Number.isInteger(tool.cap) && tool.cap > 0).toBe(true);
  });

  it("gitignores the artifact path and never tracks it", () => {
    expect(gitCheckIgnored(reportTool("test-timing").path)).toBe(true);
    expect(gitTracked(reportTool("test-timing").path)).toBe(false);
  });
});

describe("test timing: artifact format (VAL-SEC-024)", () => {
  it("normalizes a Vitest JSON report into one duration entry per test", () => {
    const report = normalizeTiming(vitestFixture([3, 0, 12]), 100);
    expect(report.tool).toBe("test-timing");
    expect(report.entries).toHaveLength(3);
    for (const entry of report.entries) {
      expect(typeof entry.file).toBe("string");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.duration).toBe("number");
      expect(entry.duration).toBeGreaterThanOrEqual(0);
    }
    expect(timingArtifactProblems(report)).toEqual([]);
  });

  it("coerces a missing duration (skipped test) to a numeric zero", () => {
    const report = normalizeTiming(vitestFixture([5, null]), 100);
    expect(report.entries[1].duration).toBe(0);
    expect(timingArtifactProblems(report)).toEqual([]);
  });

  it("truncates a noisy run at the registry cap with a note", () => {
    const cap = reportTool("test-timing").cap;
    const report = normalizeTiming(
      vitestFixture(Array.from({ length: cap + 25 }, () => 1)),
      cap
    );
    expect(report.entries).toHaveLength(cap);
    expect(report.truncated).toBe(true);
    expect(report.note).toContain(String(cap));
  });

  it("rejects an artifact whose entries lack a duration", () => {
    const problems = timingArtifactProblems({
      entries: [{ file: "a.test.mjs", name: "case", status: "passed" }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("duration");
  });

  it("rejects an artifact that is not an entries object", () => {
    expect(timingArtifactProblems(null)).not.toEqual([]);
    expect(timingArtifactProblems({ entries: "nope" })).not.toEqual([]);
  });
});

describe("test timing: CI wiring (VAL-SEC-024)", () => {
  it("shipped workflows contain the producing step and a bounded upload", () => {
    expect(timingCiProblems(readWorkflows())).toEqual([]);
  });

  it("fails when no CI step produces the timing artifact", () => {
    const problems = timingCiProblems([
      {
        path: "w.yml",
        source: CI_WORKFLOW(
          ["pnpm test"],
          "          name: timing\n          path: report/test-timing.json\n          retention-days: 7\n"
        ),
      },
    ]);
    expect(problems.some((p) => p.includes("producing step"))).toBe(true);
  });

  it("fails when no bounded upload-artifact step covers the artifact", () => {
    const problems = timingCiProblems([
      {
        path: "w.yml",
        source: `on: push
jobs:
  checks:
    steps:
      - run: pnpm test:timing
`,
      },
    ]);
    expect(problems.some((p) => p.includes("upload-artifact"))).toBe(true);
  });

  it("fails when the upload step is unbounded", () => {
    const problems = timingCiProblems([
      {
        path: "w.yml",
        source: CI_WORKFLOW(
          ["pnpm test:timing"],
          "          name: timing\n          path: report/test-timing.json\n"
        ),
      },
    ]);
    expect(problems.some((p) => p.includes("retention-days"))).toBe(true);
  });
});
