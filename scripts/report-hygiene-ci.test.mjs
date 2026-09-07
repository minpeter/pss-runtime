import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactProbePaths,
  readWorkflows,
  uncoveredPathProblems,
  workflowArtifactProblems,
} from "./report-hygiene.mjs";
import { reportTool } from "./report-paths.mjs";
import {
  createFixtureScope,
  writeBaselineFixture,
  writeJsonFixture,
} from "./test-fixtures.mjs";

// Report-hygiene invariants for the CI and cap legs (VAL-SEC-008/009):
// CI-only reports travel as bounded upload-artifact steps, and every tool
// truncates a noisy run at its registry cap with a note. The repository-side
// gitignore/tracked/status invariants live in report-hygiene.test.mjs.

const scope = createFixtureScope("report-hygiene-ci-");

afterEach(scope.cleanup);

const fixtureDir = scope.dir;

function artifactWorkflow(withBlock) {
  return `on: push
jobs:
  reports:
    steps:
      - uses: actions/upload-artifact@v7
        with:
${withBlock}
`;
}

function artifactProblems(withBlock) {
  return workflowArtifactProblems([
    { path: "w.yml", source: artifactWorkflow(withBlock) },
  ]);
}

describe("report hygiene: CI artifact bounds (VAL-SEC-008)", () => {
  it("every upload-artifact step in the shipped workflows is bounded", () => {
    expect(workflowArtifactProblems(readWorkflows())).toEqual([]);
    expect(uncoveredPathProblems(artifactProbePaths(readWorkflows()))).toEqual(
      []
    );
  });

  it("rejects an upload-artifact step without bounded retention", () => {
    const problems = artifactProblems(
      "          name: timing\n          path: report/test-timing.json\n"
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("retention-days");
  });

  it("rejects retention beyond the bounded ceiling", () => {
    const problems = artifactProblems(
      "          name: timing\n          path: report/test-timing.json\n          retention-days: 400\n"
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("retention-days");
  });

  it("rejects uploading a gate-mode tool report path", () => {
    const problems = artifactProblems(
      "          name: knip\n          path: report/knip-unused.json\n          retention-days: 7\n"
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no ci:"artifact" registry entry');
  });

  it("rejects force-staging report files from a workflow step", () => {
    const workflow = `on: push
jobs:
  reports:
    steps:
      - run: git add -f report/test-timing.json && git commit -m snapshot
`;
    const problems = workflowArtifactProblems([
      { path: "w.yml", source: workflow },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("force-stages");
  });

  it("accepts a bounded upload of a registered artifact report", () => {
    expect(
      artifactProblems(
        "          name: timing\n          path: report/test-timing.json\n          retention-days: 7\n"
      )
    ).toEqual([]);
  });

  it("reduces glob upload paths to gitignored static prefixes", () => {
    const probes = artifactProbePaths([
      {
        path: "w.yml",
        source: artifactWorkflow(
          "          name: reports\n          path: report/*.json\n          retention-days: 7\n"
        ),
      },
    ]);
    expect(probes).toEqual(["report/.probe"]);
  });
});

describe("report hygiene: capped noisy runs (VAL-SEC-009)", () => {
  // Runs a wrapper in REPORT mode over a synthetic input holding cap+25
  // findings and asserts truncation at the registry cap with a note.
  function expectTruncatedReport(wrapper, input, cap, dir) {
    const out = join(dir, "report.json");
    const result = spawnSync(
      "node",
      [
        wrapper,
        "--report",
        "--input",
        input,
        "--baseline",
        writeBaselineFixture(dir),
        "--out",
        out,
      ],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.signatures).toHaveLength(cap);
    expect(report.truncated).toBe(true);
    expect(report.note).toContain(String(cap));
  }

  it("knip REPORT truncates a synthetic noisy run at the registry cap with a note", () => {
    const dir = fixtureDir();
    const cap = reportTool("knip").cap;
    const input = writeJsonFixture(dir, "knip-report.json", {
      issues: Array.from({ length: cap + 25 }, (_, index) => ({
        file: `src/f${index}.ts`,
        exports: [{ name: `sym${index}` }],
      })),
    });
    expectTruncatedReport("scripts/check-unused.mjs", input, cap, dir);
  });

  it("jscpd REPORT truncates a synthetic noisy run at the registry cap with a note", () => {
    const dir = fixtureDir();
    const cap = reportTool("jscpd").cap;
    const input = writeJsonFixture(dir, "jscpd-report.json", {
      duplicates: Array.from({ length: cap + 25 }, (_, index) => ({
        firstFile: { name: `src/f${index}.ts`, start: 1, end: 9 },
        secondFile: { name: `src/g${index}.ts`, start: 20, end: 28 },
      })),
    });
    expectTruncatedReport("scripts/check-duplicates.mjs", input, cap, dir);
  });
});
