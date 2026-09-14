import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_ENTRY_CAP } from "./knip-unused.mjs";
import {
  createFixtureScope,
  writeBaselineFixture,
  writeJsonFixture,
} from "./test-fixtures.mjs";

// Wrapper behavior tests for scripts/check-duplicates.mjs (VAL-SEC-002/004/009
// jscpd leg): deterministic, offline, parallel-safe; all fixtures live under
// the gitignored .omo/tmp tree (scripts/test-fixtures.mjs).

const WRAPPER = "scripts/check-duplicates.mjs";
const DEFAULT_BIN = "node_modules/.bin/jscpd";
const scope = createFixtureScope("check-duplicates-");

afterEach(scope.cleanup);

const fixtureDir = scope.dir;

function duplicate(aName, aStart, aEnd, bName, bStart, bEnd) {
  return {
    format: "typescript",
    lines: aEnd - aStart + 1,
    tokens: 120,
    fragment: "",
    firstFile: { name: aName, start: aStart, end: aEnd },
    secondFile: { name: bName, start: bStart, end: bEnd },
  };
}

function reportFixture(dir, duplicates) {
  return writeJsonFixture(dir, "jscpd-report.json", { duplicates });
}

function baselineFixture(dir, signatures) {
  return writeBaselineFixture(dir, signatures);
}

function run(args) {
  return spawnSync("node", [WRAPPER, ...args], { encoding: "utf8" });
}

const DUP_A = duplicate("src/a.ts", 1, 9, "src/b.ts", 20, 28);
const DUP_B = duplicate("src/c.ts", 1, 9, "src/d.ts", 20, 28);
const SIG_A = "duplicates:src/a.ts:1-9=src/b.ts:20-28";
const SIG_B = "duplicates:src/c.ts:1-9=src/d.ts:20-28";

describe("check:duplicates wrapper", () => {
  it("--help prints usage and exits 0 (VAL-SEC-007)", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATE");
    expect(result.stdout).toContain("--report");
  });

  it("GATE exits 0 when findings match the baseline exactly (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, [DUP_A]),
      "--baseline",
      baselineFixture(dir, [SIG_A]),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("check:duplicates OK");
  });

  it("GATE exits non-zero on a new un-baselined signature (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, [DUP_A, DUP_B]),
      "--baseline",
      baselineFixture(dir, [SIG_A]),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`NEW ${SIG_B}`);
  });

  it("GATE exits non-zero on a stale baseline signature (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, []),
      "--baseline",
      baselineFixture(dir, [SIG_A]),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`STALE ${SIG_A}`);
  });

  it("REPORT writes a bounded report to the --out path and exits 0 even with new findings (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const out = join(dir, "report.json");
    const result = run([
      "--report",
      "--input",
      reportFixture(dir, [DUP_A, DUP_B]),
      "--baseline",
      baselineFixture(dir, [SIG_A]),
      "--out",
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.totalSignatures).toBe(2);
    expect(report.newSignatures).toEqual([SIG_B]);
    expect(report.truncated).toBe(false);
  });

  it("REPORT truncates a noisy run at the documented cap with a note (VAL-SEC-009)", () => {
    const dir = fixtureDir();
    const duplicates = Array.from(
      { length: REPORT_ENTRY_CAP + 25 },
      (_, index) =>
        duplicate(`src/f${index}.ts`, 1, 9, `src/g${index}.ts`, 20, 28)
    );
    const out = join(dir, "report.json");
    const result = run([
      "--report",
      "--input",
      reportFixture(dir, duplicates),
      "--baseline",
      baselineFixture(dir, []),
      "--out",
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.totalSignatures).toBe(REPORT_ENTRY_CAP + 25);
    expect(report.signatures).toHaveLength(REPORT_ENTRY_CAP);
    expect(report.newSignatures).toHaveLength(REPORT_ENTRY_CAP);
    expect(report.totalNewSignatures).toBe(REPORT_ENTRY_CAP + 25);
    expect(report.truncated).toBe(true);
    expect(report.note).toContain(String(REPORT_ENTRY_CAP));
  });

  it("caps stale-only overflow and keeps the uncapped total", () => {
    const dir = fixtureDir();
    const stale = Array.from(
      { length: REPORT_ENTRY_CAP + 25 },
      (_, i) => `duplicates:src/old${i}.ts:1-9=src/removed.ts:1-9`
    ).sort();
    const out = join(dir, "stale.json");
    const result = run([
      "--report",
      "--input",
      reportFixture(dir, []),
      "--baseline",
      baselineFixture(dir, stale),
      "--out",
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.signatures).toEqual([]);
    expect(report.staleSignatures).toEqual(stale.slice(0, REPORT_ENTRY_CAP));
    expect(report.totalStaleSignatures).toBe(stale.length);
    expect(report.truncated).toBe(true);
  });

  it("fails closed when the binary is absent (VAL-SEC-004)", () => {
    const dir = fixtureDir();
    const result = run(["--bin", join(dir, "no-such-jscpd-binary")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failing closed");
  });

  it("skips an unavailable tool only with explicit local opt-in (VAL-SEC-004)", () => {
    const dir = fixtureDir();
    const fake = join(dir, "fake-jscpd");
    writeFileSync(fake, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const result = run(["--allow-unavailable", "--bin", fake]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SKIP check:duplicates unavailable");
    expect(result.stdout).toContain("explicitly allowed, not a pass");
  });

  it("fails the run when the committed baseline file is unreadable", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, [DUP_A]),
      "--baseline",
      join(dir, "missing-baseline.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read baseline");
  });

  it("never writes a report outside the requested --out path", () => {
    const dir = fixtureDir();
    const result = run([
      "--report",
      "--input",
      reportFixture(dir, [DUP_A]),
      "--baseline",
      baselineFixture(dir, [SIG_A]),
      "--out",
      join(dir, "nested", "report.json"),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dir, "nested", "report.json"))).toBe(true);
  });

  // This integration case cannot exercise the production scanner when the
  // binary is absent; unlike this test-only guard, the CI gate fails closed.
  it.skipIf(!existsSync(DEFAULT_BIN))(
    "production ignores exclude changelogs but retain README and source duplicates (VAL-SEC-003)",
    () => {
      const dir = fixtureDir();
      const tree = join(dir, "tree");
      const sourceBlock = [
        "export function alpha(value: number): number {",
        "  const stepOne = value + 1;",
        "  const stepTwo = stepOne * 2;",
        "  const stepThree = stepTwo - 3;",
        "  const stepFour = stepThree / 4;",
        "  const stepFive = stepFour + 5;",
        "  const stepSix = stepFive * 6;",
        "  const stepSeven = stepSix - 7;",
        "  const stepEight = stepSeven / 8;",
        "  const stepNine = stepEight + 9;",
        "  const stepTen = stepNine * 10;",
        "  return stepTen;",
        "}",
        "",
      ].join("\n");
      const proseBlock = `${Array.from(
        { length: 8 },
        () =>
          "A generated release paragraph repeats stable words for duplicate scanner verification."
      ).join("\n")}\n`;
      mkdirSync(join(tree, "src"), { recursive: true });
      mkdirSync(join(tree, "docs"), { recursive: true });
      writeFileSync(join(tree, "src", "dup-a.ts"), sourceBlock);
      writeFileSync(
        join(tree, "src", "dup-b.ts"),
        sourceBlock.replaceAll("alpha", "beta")
      );
      writeFileSync(join(tree, "CHANGELOG.md"), proseBlock.repeat(2));
      writeFileSync(join(tree, "README.md"), proseBlock);
      writeFileSync(join(tree, "docs", "README.md"), proseBlock);
      const out = join(dir, "report.json");
      const result = run([
        "--report",
        "--baseline",
        baselineFixture(dir, []),
        "--out",
        out,
        tree,
      ]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8"));
      const signatures = JSON.stringify(report.signatures);
      expect(signatures).toContain("README.md");
      expect(signatures).toContain("src/dup-a.ts");
      expect(signatures).not.toContain("CHANGELOG.md");
    }
  );
});
