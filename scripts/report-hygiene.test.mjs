import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { JSCPD_REPORT_PATH } from "./jscpd-duplicates.mjs";
import { KNIP_REPORT_PATH, REPORT_ENTRY_CAP } from "./knip-unused.mjs";
import {
  GITIGNORE_PATH,
  probePaths,
  reportPatternProblems,
  trackedReportProblems,
  uncoveredPathProblems,
  untrackedReportProblems,
} from "./report-hygiene.mjs";
import { registryProblems, reportTool } from "./report-paths.mjs";
import {
  createFixtureScope,
  writeBaselineFixture,
  writeJsonFixture,
} from "./test-fixtures.mjs";

// Report-hygiene invariants (VAL-SEC-008): report destinations are
// gitignored and untracked, and a full analysis run leaves `git status` free
// of report files. CI artifact bounds and noisy-run caps live in
// scripts/report-hygiene-ci.test.mjs.

const scope = createFixtureScope("report-hygiene-");
const tempFiles = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    rmSync(file, { force: true });
  }
  scope.cleanup();
});

const fixtureDir = scope.dir;

function gitStatusPorcelain() {
  return spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .stdout;
}

describe("report hygiene: registry shape (VAL-SEC-008/009)", () => {
  it("declares every analysis tool with an ignored path and a positive cap", () => {
    expect(registryProblems()).toEqual([]);
    for (const id of [
      "knip",
      "jscpd",
      "drift",
      "bundle-budget",
      "test-timing",
      "flaky",
    ]) {
      expect(reportTool(id), `registry entry for ${id}`).toBeDefined();
    }
  });

  it("rejects a registry entry without a cap or outside an ignored root", () => {
    const problems = registryProblems([
      { id: "bad-cap", path: "report/x.json", cap: 0, ci: "local" },
      { id: "bad-path", path: "docs/x.json", cap: 10, ci: "local" },
      { id: "bad-ci", path: "report/y.json", cap: 10, ci: "commit" },
      { id: "bad-cap", path: "report/x.json", cap: 5, ci: "local" },
    ]);
    expect(problems.some((p) => p.includes("positive integer"))).toBe(true);
    expect(problems.some((p) => p.includes("under one of"))).toBe(true);
    expect(problems.some((p) => p.includes("local, artifact"))).toBe(true);
    expect(problems.some((p) => p.includes("duplicate report tool id"))).toBe(
      true
    );
    expect(problems.some((p) => p.includes("duplicate report path"))).toBe(
      true
    );
  });
});

describe("report hygiene: gitignore coverage (VAL-SEC-008)", () => {
  it("carries the additive report pattern in .gitignore", () => {
    expect(reportPatternProblems(readFileSync(GITIGNORE_PATH, "utf8"))).toEqual(
      []
    );
  });

  it("matches every declared report path and root variant via git check-ignore", () => {
    expect(uncoveredPathProblems(probePaths())).toEqual([]);
  });

  it("flags a path no .gitignore pattern covers", () => {
    const problems = uncoveredPathProblems(["scripts/.hygiene-probe"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("scripts/.hygiene-probe");
  });

  it("tracks no report file in git", () => {
    expect(trackedReportProblems()).toEqual([]);
  });
});

describe("report hygiene: wrapper-registry consistency (VAL-SEC-009)", () => {
  it("knip and jscpd wrappers use the registry path and cap", () => {
    expect(KNIP_REPORT_PATH).toBe(reportTool("knip").path);
    expect(REPORT_ENTRY_CAP).toBe(reportTool("knip").cap);
    expect(JSCPD_REPORT_PATH).toBe(reportTool("jscpd").path);
    expect(reportTool("knip").cap).toBe(reportTool("jscpd").cap);
  });
});

describe("report hygiene: post-run git status (VAL-SEC-008)", () => {
  it("a full REPORT-mode run leaves git status free of report files", () => {
    const dir = fixtureDir();
    const input = writeJsonFixture(dir, "knip-report.json", {
      issues: [{ file: "src/a.ts", exports: [{ name: "foo" }] }],
    });
    const hadReport = existsSync(KNIP_REPORT_PATH);
    const prior = hadReport ? readFileSync(KNIP_REPORT_PATH, "utf8") : null;
    if (!hadReport) {
      tempFiles.push(KNIP_REPORT_PATH);
    }
    try {
      // No --out: the wrapper writes its default gitignored report path.
      const result = spawnSync(
        "node",
        [
          "scripts/check-unused.mjs",
          "--report",
          "--input",
          input,
          "--baseline",
          writeBaselineFixture(dir),
        ],
        { encoding: "utf8" }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(KNIP_REPORT_PATH);
      expect(existsSync(KNIP_REPORT_PATH)).toBe(true);
      expect(untrackedReportProblems(gitStatusPorcelain())).toEqual([]);
      expect(uncoveredPathProblems([KNIP_REPORT_PATH])).toEqual([]);
    } finally {
      if (prior !== null) {
        writeFileSync(KNIP_REPORT_PATH, prior);
      }
    }
  });

  it("flags report files that appear in git status output", () => {
    const porcelain = [
      "?? report/knip-unused.json",
      " M .senpi/session.json",
      "?? .omo/plans/shared-plan.md",
      "?? src/unrelated.ts",
    ].join("\n");
    const problems = untrackedReportProblems(porcelain);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("report/knip-unused.json");
    expect(problems[1]).toContain(".senpi/session.json");
  });
});
