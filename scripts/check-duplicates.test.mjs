import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_ENTRY_CAP } from "./knip-unused.mjs";

// Wrapper behavior tests for scripts/check-duplicates.mjs (VAL-SEC-002/004/009
// jscpd leg): deterministic, offline, parallel-safe; all fixtures live under
// the gitignored .omo/tmp tree.

const WRAPPER = "scripts/check-duplicates.mjs";
const DEFAULT_BIN = "node_modules/.bin/jscpd";
const FIXTURE_BASE = ".omo/tmp";
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function fixtureDir() {
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_BASE, "check-duplicates-"));
  tempDirs.push(dir);
  return dir;
}

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
  const path = join(dir, "jscpd-report.json");
  writeFileSync(path, JSON.stringify({ duplicates }));
  return path;
}

function baselineFixture(dir, signatures) {
  const path = join(dir, "baseline.json");
  writeFileSync(path, JSON.stringify({ version: 1, signatures }));
  return path;
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
    expect(report.truncated).toBe(true);
    expect(report.note).toContain(String(REPORT_ENTRY_CAP));
  });

  it("emits an explicit SKIP message and exits 0 when the binary is absent (VAL-SEC-004)", () => {
    const dir = fixtureDir();
    const result = run(["--bin", join(dir, "no-such-jscpd-binary")]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SKIP check:duplicates");
    expect(result.stdout).toContain("not a pass");
  });

  it("emits an explicit SKIP message and exits 0 when the tool fails to execute (VAL-SEC-004)", () => {
    const dir = fixtureDir();
    const fake = join(dir, "fake-jscpd");
    writeFileSync(fake, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const result = run(["--bin", fake]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SKIP check:duplicates");
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

  // Availability-classified (VAL-SEC-004): when the jscpd binary is not
  // installed this leg is a documented skip, exactly like the GATE itself.
  it.skipIf(!existsSync(DEFAULT_BIN))(
    "a synthetic duplicate inside an ignored directory produces no finding (VAL-SEC-003)",
    () => {
      const dir = fixtureDir();
      const tree = join(dir, "tree");
      const block = [
        "export function alpha(value: number): number {",
        "  const stepOne = value + 1;",
        "  const stepTwo = stepOne * 2;",
        "  const stepThree = stepTwo - 3;",
        "  const stepFour = stepThree / 4;",
        "  const stepFive = stepFour + 5;",
        "  const stepSix = stepFive * 6;",
        "  return stepSix;",
        "}",
        "",
      ].join("\n");
      for (const scope of ["dist", "src"]) {
        mkdirSync(join(tree, scope), { recursive: true });
        writeFileSync(join(tree, scope, "dup-a.ts"), block);
        writeFileSync(
          join(tree, scope, "dup-b.ts"),
          block.replaceAll("alpha", "beta")
        );
      }
      const config = join(dir, "jscpd.json");
      writeFileSync(
        config,
        JSON.stringify({
          minTokens: 20,
          minLines: 3,
          ignore: ["**/dist/**"],
          allowlist: [],
        })
      );
      const out = join(dir, "report.json");
      const result = run([
        "--report",
        "--config",
        config,
        "--baseline",
        baselineFixture(dir, []),
        "--out",
        out,
        tree,
      ]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8"));
      expect(report.totalSignatures).toBe(1);
      expect(report.signatures[0]).toContain("src/dup-a.ts");
      expect(JSON.stringify(report.signatures)).not.toContain("dist/");
    }
  );
});
