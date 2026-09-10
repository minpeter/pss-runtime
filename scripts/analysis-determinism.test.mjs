import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_CHECKS,
  enumerationProblems,
  nondeterminismProblems,
  reportsEqual,
  stableStringify,
  timingComparisonKey,
} from "./analysis-determinism.mjs";
import { aggregateRunReports, buildFlakyReport } from "./flaky-tests.mjs";
import { reportTool } from "./report-paths.mjs";
import { normalizeTiming } from "./test-timing.mjs";

// Invariants for VAL-SEC-043: every new analysis/security check (Knip,
// jscpd, drift, bundle budget, Worker coverage, timing, flaky) is
// deterministic and offline. Static scans prove the report-producing sources
// read no clock, sample no randomness, touch no network, and sort every
// directory enumeration; dynamic proofs double-run the pure drift check and
// the report normalizers. The full twice-run transcript per check is
// captured under .omo/evidence/sec-determinism-and-node-matrix/.

const DRIFT_WRAPPER = "scripts/check-workspace-version-drift.mjs";
const DOUBLE_RUN_DIR = ".omo/tmp/determinism";
const ISOLATED_ENV = {
  ...process.env,
  PSS_TASK_VALIDATOR_NETWORK_ISOLATED: "1",
  TMPDIR: ".omo/tmp",
};

function readSource(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function runDrift(args) {
  return spawnSync(process.execPath, [DRIFT_WRAPPER, ...args], {
    encoding: "utf8",
    env: ISOLATED_ENV,
  });
}

describe("analysis checks: registry and sources (VAL-SEC-043)", () => {
  it("every declared check source exists and registry ids resolve", () => {
    for (const check of ANALYSIS_CHECKS) {
      for (const source of check.sources) {
        expect(
          readSource(source),
          `${check.id} source ${source} is missing`
        ).not.toBeNull();
      }
      if (check.report !== null) {
        expect(
          reportTool(check.report),
          `${check.id} report id "${check.report}" must be registered`
        ).toBeDefined();
      }
    }
  });

  it("covers the seven new checks", () => {
    expect(ANALYSIS_CHECKS.map((check) => check.id).sort()).toEqual([
      "bundle-budget",
      "drift",
      "flaky",
      "jscpd",
      "knip",
      "test-timing",
      "worker-coverage",
    ]);
  });
});

describe("analysis checks: deterministic offline sources (VAL-SEC-043)", () => {
  it("no report-producing source reads the clock, samples randomness, or uses the network", () => {
    for (const check of ANALYSIS_CHECKS) {
      for (const source of check.sources) {
        expect(nondeterminismProblems(source, readSource(source))).toEqual([]);
      }
    }
  });

  it("every directory enumeration is sorted", () => {
    for (const check of ANALYSIS_CHECKS) {
      for (const source of check.sources) {
        expect(enumerationProblems(source, readSource(source))).toEqual([]);
      }
    }
  });

  it("the static scan flags nondeterministic fixtures", () => {
    // Negative cases: clock, randomness, and network fixtures must fail.
    expect(
      nondeterminismProblems("fixture", "const t = Date.now();")
    ).not.toEqual([]);
    expect(nondeterminismProblems("fixture", "await fetch(url);")).not.toEqual(
      []
    );
    expect(
      enumerationProblems("fixture", "readdirSync(dir).map(String)")
    ).not.toEqual([]);
  });
});

describe("analysis checks: report comparison (VAL-SEC-043)", () => {
  it("stableStringify canonicalizes object key order", () => {
    expect(
      reportsEqual({ b: 1, a: { d: [2], c: 3 } }, { a: { c: 3, d: [2] }, b: 1 })
    ).toBe(true);
    // Negative case: differing content must compare unequal.
    expect(reportsEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("the timing normalizer is deterministic across repeated calls", () => {
    const fixture = {
      testResults: [
        {
          name: `${process.cwd()}/scripts/b.test.mjs`,
          assertionResults: [
            { fullName: "b > two", status: "passed", duration: 5 },
            { fullName: "b > one", status: "passed", duration: 3 },
          ],
        },
        {
          name: `${process.cwd()}/scripts/a.test.mjs`,
          assertionResults: [
            { fullName: "a > only", status: "passed", duration: 1 },
          ],
        },
      ],
    };
    const first = normalizeTiming(fixture);
    const second = normalizeTiming(fixture);
    expect(reportsEqual(first, second)).toBe(true);
    // Two runs of the same suite differ only in measured durations; the
    // comparison key zeroes them and must compare equal.
    const rerun = normalizeTiming({
      testResults: fixture.testResults.map((file) => ({
        ...file,
        assertionResults: file.assertionResults.map((assertion) => ({
          ...assertion,
          duration: assertion.duration + 100,
        })),
      })),
    });
    expect(timingComparisonKey(first)).toBe(timingComparisonKey(rerun));
    // Negative case: a different executed-test set must compare unequal.
    const changed = normalizeTiming({
      testResults: [
        {
          name: `${process.cwd()}/scripts/a.test.mjs`,
          assertionResults: [
            { fullName: "a > renamed", status: "passed", duration: 1 },
          ],
        },
      ],
    });
    expect(timingComparisonKey(first)).not.toBe(timingComparisonKey(changed));
  });

  it("the flaky aggregation is deterministic and sorted", () => {
    const run = {
      testResults: [
        {
          name: `${process.cwd()}/scripts/b.test.mjs`,
          assertionResults: [{ fullName: "b > case", status: "passed" }],
        },
        {
          name: `${process.cwd()}/scripts/a.test.mjs`,
          assertionResults: [{ fullName: "a > case", status: "passed" }],
        },
      ],
    };
    const first = buildFlakyReport(aggregateRunReports([run, run]), {
      runs: 2,
      timeoutSeconds: 300,
    });
    const second = buildFlakyReport(aggregateRunReports([run, run]), {
      runs: 2,
      timeoutSeconds: 300,
    });
    expect(reportsEqual(first, second)).toBe(true);
    const files = first.entries.map((entry) => entry.file);
    expect(files).toEqual([...files].sort());
    // Negative case: a flaky classification changes the report content.
    const failing = {
      testResults: [
        {
          name: `${process.cwd()}/scripts/b.test.mjs`,
          assertionResults: [{ fullName: "b > case", status: "failed" }],
        },
      ],
    };
    const mutated = buildFlakyReport(aggregateRunReports([run, failing]), {
      runs: 2,
      timeoutSeconds: 300,
    });
    expect(reportsEqual(first, mutated)).toBe(false);
    expect(mutated.entries.some((entry) => entry.status === "flaky")).toBe(
      true
    );
  });
});

describe("analysis checks: drift double-run under network isolation (VAL-SEC-043)", () => {
  it("two report-mode runs produce identical exit codes and report bytes", () => {
    mkdirSync(DOUBLE_RUN_DIR, { recursive: true });
    const out1 = `${DOUBLE_RUN_DIR}/drift-run1.json`;
    const out2 = `${DOUBLE_RUN_DIR}/drift-run2.json`;
    const run1 = runDrift(["--report", "--out", out1]);
    const run2 = runDrift(["--report", "--out", out2]);
    expect(run1.error).toBeUndefined();
    expect(run2.error).toBeUndefined();
    expect(run2.status).toBe(run1.status);
    // Stdout names the --out path; normalize it away before comparing.
    expect(run2.stdout.replaceAll(out2, "<out>")).toBe(
      run1.stdout.replaceAll(out1, "<out>")
    );
    expect(readFileSync(out2, "utf8")).toBe(readFileSync(out1, "utf8"));
  });

  it("two gate-mode runs produce identical exit codes and output", () => {
    const run1 = runDrift(["--check"]);
    const run2 = runDrift(["--check"]);
    expect(run2.status).toBe(run1.status);
    expect(run2.stdout).toBe(run1.stdout);
    expect(run2.stderr).toBe(run1.stderr);
    // Negative case: the comparison must detect a divergent report.
    expect(stableStringify({ run: 1 })).not.toBe(stableStringify({ run: 2 }));
  });
});
