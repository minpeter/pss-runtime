// Invariants for the serial two-checkout reproducibility harness
// (VAL-CROSS-014): CONTRIBUTING documents a concrete numeric wall-clock
// bound for one clean-checkout install+validation run (analogous to the
// pre-commit ≤ 60 s bound) and the harness default enforces exactly that
// number; the harness runs two clean checkouts SERIALLY from the lockfile,
// compares deterministic outputs between the runs, captures both elapsed
// times, and leaves the original repository clean.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareDigests,
  DEFAULT_BOUND_SECONDS,
  documentedBoundProblems,
  elapsedProblems,
  parseVitestSummary,
  RUN_LABELS,
} from "./two-checkout-repro.mjs";

const BOUND_NUMBER = /(check:two-checkout-repro[^\n]*?≤\s*)\d+(\s*s)/;
const HARNESS_PATH = "scripts/check-two-checkout-repro.mjs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const source = readFileSync(HARNESS_PATH, "utf8");
const helpers = readFileSync("scripts/two-checkout-repro.mjs", "utf8");

const DIGEST = {
  steps: { install: 0, invariants: 0, lint: 0 },
  suites: ["scripts/a.test.mjs", "scripts/b.test.mjs"],
  summary: { testFiles: [2, 2], tests: [10, 10] },
  discoveryProblems: [],
  checkoutStatus: "",
};

describe("cross: documented two-checkout bound (VAL-CROSS-014)", () => {
  it("documents a numeric wall-clock bound matching the harness default", () => {
    expect(documentedBoundProblems(contributing)).toEqual([]);
  });

  it("fails when the documented bound is missing or drifts from the harness", () => {
    expect(documentedBoundProblems("no bound here")).toEqual([
      "CONTRIBUTING.md documents no numeric wall-clock bound for the two-checkout reproducibility run",
    ]);
    const renumbered = contributing.replace(
      BOUND_NUMBER,
      `$1${DEFAULT_BOUND_SECONDS + 1}$2`
    );
    expect(documentedBoundProblems(renumbered)).toEqual([
      `CONTRIBUTING.md documents a ${DEFAULT_BOUND_SECONDS + 1}s per-checkout bound but the harness enforces ${DEFAULT_BOUND_SECONDS}s`,
    ]);
  });

  it("wires the documented command to the harness as a root script", () => {
    expect(pkg.scripts["check:two-checkout-repro"]).toBe(
      "node scripts/check-two-checkout-repro.mjs"
    );
  });
});

describe("cross: harness source contract (VAL-CROSS-014)", () => {
  it("runs exactly two checkouts, one at a time", () => {
    expect(RUN_LABELS).toEqual(["run1", "run2"]);
    // The serial loop over RUN_LABELS is the only checkout driver.
    expect(source).toContain("for (const label of RUN_LABELS)");
  });

  it("reinstalls from the lockfile with a frozen install and cleans scratch", () => {
    expect(source).toContain('"--frozen-lockfile"');
    expect(source).toContain("rmSync(scratch");
  });

  it("keeps evidence on the gitignored .omo/evidence tree by default", () => {
    expect(helpers).toContain('".omo/evidence/two-checkout-repro"');
  });

  it("times each checkout run and enforces the bound on both", () => {
    expect(source).toContain("performance.now()");
    expect(source).toContain("elapsedProblems(runs, args.bound)");
  });

  it("verifies the original repository reports a clean tree afterwards", () => {
    expect(helpers).toContain('"status", "--porcelain"');
    expect(source).toContain('gitPorcelain(".")');
  });
});

describe("cross: vitest summary parsing (VAL-CROSS-014)", () => {
  it("parses the ANSI-coloured summary into pass/total counts", () => {
    const text =
      "[2m Test Files [22m [1m[32m66 passed[39m[22m[2m (66)[39m\n" +
      "[2m      Tests [22m [1m[32m645 passed[39m[22m[2m (645)[39m\n";
    expect(parseVitestSummary(text)).toEqual({
      testFiles: [66, 66],
      tests: [645, 645],
    });
  });

  it("tolerates skipped/failed segments between the counts and totals", () => {
    const text =
      " Test Files  74 passed (74)\n      Tests  817 passed | 1 skipped (818)\n";
    expect(parseVitestSummary(text)).toEqual({
      testFiles: [74, 74],
      tests: [817, 818],
    });
  });

  it("returns null when the summary is absent", () => {
    expect(parseVitestSummary("no vitest output")).toBeNull();
  });
});

describe("cross: deterministic-output comparison (VAL-CROSS-014)", () => {
  it("accepts identical digests from both runs", () => {
    expect(compareDigests(DIGEST, structuredClone(DIGEST))).toEqual([]);
  });

  it("names the digest field that disagrees between runs", () => {
    const drifted = structuredClone(DIGEST);
    drifted.summary = { testFiles: [2, 2], tests: [11, 11] };
    drifted.checkoutStatus = "?? stray.tmp";
    expect(compareDigests(DIGEST, drifted)).toEqual([
      'deterministic output "summary" disagrees between the two serial checkout runs',
      'deterministic output "checkoutStatus" disagrees between the two serial checkout runs',
    ]);
  });
});

describe("cross: per-checkout elapsed bound (VAL-CROSS-014)", () => {
  it("accepts both runs within the bound", () => {
    const runs = [
      { label: "run1", seconds: 61.2 },
      { label: "run2", seconds: 55.9 },
    ];
    expect(elapsedProblems(runs, 120)).toEqual([]);
  });

  it("fails a run that exceeds the documented bound, naming both", () => {
    const runs = [
      { label: "run1", seconds: 61.2 },
      { label: "run2", seconds: 130.4 },
    ];
    expect(elapsedProblems(runs, 120)).toEqual([
      "run2 ran 130.4s, over the documented 120s per-checkout bound",
    ]);
  });
});
