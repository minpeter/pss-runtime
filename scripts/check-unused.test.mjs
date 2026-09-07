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

// Wrapper behavior tests for scripts/check-unused.mjs (VAL-SEC-002/004/009):
// deterministic, offline, parallel-safe; all fixtures live under the
// gitignored .omo/tmp tree.

const WRAPPER = "scripts/check-unused.mjs";
const FIXTURE_BASE = ".omo/tmp";
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function fixtureDir() {
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_BASE, "check-unused-"));
  tempDirs.push(dir);
  return dir;
}

function reportFixture(dir, rows) {
  const path = join(dir, "knip-report.json");
  writeFileSync(path, JSON.stringify({ issues: rows }));
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

const ROW_FOO = { file: "src/a.ts", exports: [{ name: "foo" }] };
const ROW_BAR = { file: "src/b.ts", types: [{ name: "Bar" }] };

describe("check:unused wrapper", () => {
  it("--help prints usage and exits 0 (VAL-SEC-001)", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATE");
    expect(result.stdout).toContain("--report");
  });

  it("GATE exits 0 when findings match the baseline exactly (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, [ROW_FOO]),
      "--baseline",
      baselineFixture(dir, ["exports:src/a.ts#foo"]),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("check:unused OK");
  });

  it("GATE exits non-zero on a new un-baselined signature (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, [ROW_FOO, ROW_BAR]),
      "--baseline",
      baselineFixture(dir, ["exports:src/a.ts#foo"]),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEW types:src/b.ts#Bar");
  });

  it("GATE exits non-zero on a stale baseline signature (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, []),
      "--baseline",
      baselineFixture(dir, ["exports:src/a.ts#foo"]),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STALE exports:src/a.ts#foo");
  });

  it("REPORT writes a bounded report to the --out path and exits 0 even with new findings (VAL-SEC-002)", () => {
    const dir = fixtureDir();
    const out = join(dir, "report.json");
    const result = run([
      "--report",
      "--input",
      reportFixture(dir, [ROW_FOO, ROW_BAR]),
      "--baseline",
      baselineFixture(dir, ["exports:src/a.ts#foo"]),
      "--out",
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.totalSignatures).toBe(2);
    expect(report.newSignatures).toEqual(["types:src/b.ts#Bar"]);
    expect(report.truncated).toBe(false);
  });

  it("REPORT truncates a noisy run at the documented cap with a note (VAL-SEC-009)", () => {
    const dir = fixtureDir();
    const rows = Array.from({ length: REPORT_ENTRY_CAP + 25 }, (_, index) => ({
      file: `src/f${index}.ts`,
      exports: [{ name: `sym${index}` }],
    }));
    const out = join(dir, "report.json");
    const result = run([
      "--report",
      "--input",
      reportFixture(dir, rows),
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
    const result = run(["--bin", join(dir, "no-such-knip-binary")]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SKIP check:unused");
    expect(result.stdout).toContain("not a pass");
  });

  it("emits an explicit SKIP message and exits 0 when the tool fails to execute (VAL-SEC-004)", () => {
    const dir = fixtureDir();
    const fake = join(dir, "fake-knip");
    writeFileSync(fake, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const result = run(["--bin", fake]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SKIP check:unused");
  });

  it("fails the run when the committed baseline file is unreadable", () => {
    const dir = fixtureDir();
    const result = run([
      "--input",
      reportFixture(dir, [ROW_FOO]),
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
      reportFixture(dir, [ROW_FOO]),
      "--baseline",
      baselineFixture(dir, ["exports:src/a.ts#foo"]),
      "--out",
      join(dir, "nested", "report.json"),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dir, "nested", "report.json"))).toBe(true);
  });
});
