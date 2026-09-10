import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLE_BASELINE_PATH, baselineProblems } from "./bundle-size.mjs";
import { createFixtureScope, writeJsonFixture } from "./test-fixtures.mjs";

// Wrapper behavior tests for scripts/check-bundle-size.mjs
// (VAL-SEC-015..019): deterministic, offline, parallel-safe; all fixtures
// live under the gitignored .omo/tmp tree (scripts/test-fixtures.mjs). The
// real-repository case assumes `pnpm build` ran first — the canonical gate
// (pnpm test) always builds before collecting scripts/*.test.mjs. On a fresh
// checkout with no dist/ it skips explicitly (documented skip, never a
// silent pass): the fixture-based cases below cover the gate semantics on
// any tree, and the standalone invariant gate (`vitest run
// scripts/*.test.mjs`) must stay green on an unbuilt checkout per
// CONTRIBUTING's fast-local-gates contract (VAL-CROSS-001).

const WRAPPER = "scripts/check-bundle-size.mjs";
const WILDCARD_PATTERN = /[*?[{]/;
const scope = createFixtureScope("check-bundle-size-");

// True only when the working tree carries a real build.
const REAL_BUILD_PRESENT =
  existsSync("packages/runtime/dist/index.js") &&
  existsSync("apps/coding-agent/dist/cli.js");

afterEach(scope.cleanup);

const fixtureDir = scope.dir;

function run(args) {
  return spawnSync("node", [WRAPPER, ...args], { encoding: "utf8" });
}

function writeDistFile(root, path, bytes) {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes, 65));
  return full;
}

function writeBudgetFixture(root, artifacts, tolerancePercent = 5) {
  return writeJsonFixture(root, "budget.json", {
    version: 1,
    tolerancePercent,
    artifacts,
  });
}

function check(root, baseline, extra = []) {
  return run(["--check", "--root", root, "--baseline", baseline, ...extra]);
}

describe("check:bundle-size wrapper", () => {
  it("no-arg prints usage and exits 0 (VAL-SEC-015)", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--check");
  });

  it("--help prints usage and exits 0 (VAL-SEC-015)", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("is wired to the root check:bundle-size script (VAL-SEC-015)", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.scripts["check:bundle-size"]).toBe(
      "node scripts/check-bundle-size.mjs --check"
    );
  });

  it("wrapper and helper stay under the 250 pure-LOC ceiling (VAL-SEC-015)", () => {
    for (const path of [WRAPPER, "scripts/bundle-size.mjs"]) {
      const pureLines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return (
            trimmed.length > 0 &&
            !trimmed.startsWith("//") &&
            !trimmed.startsWith("#")
          );
        }).length;
      expect(pureLines, path).toBeLessThanOrEqual(250);
    }
  });

  it.skipIf(!REAL_BUILD_PRESENT)(
    "GATE passes on the real repository build and measures real dist sizes (VAL-SEC-016)",
    () => {
      const result = run(["--check"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("check:bundle-size OK");
      const dir = fixtureDir();
      const out = join(dir, "report.json");
      const report = run(["--report", "--out", out]);
      expect(report.status, report.stderr).toBe(0);
      const rows = JSON.parse(readFileSync(out, "utf8")).artifacts;
      const row = rows.find((r) => r.path === "packages/runtime/dist/index.js");
      expect(row.measured).toBe(statSync(row.path).size);
      expect(row.measured).toBeGreaterThan(0);
    }
  );

  it("truncating a dist file changes the measured value (VAL-SEC-016)", () => {
    const dir = fixtureDir();
    const artifact = "packages/fixture/dist/index.js";
    const full = writeDistFile(dir, artifact, 4096);
    const baseline = writeBudgetFixture(dir, { [artifact]: 4096 });
    const firstOut = join(dir, "first.json");
    expect(
      run([
        "--report",
        "--root",
        dir,
        "--baseline",
        baseline,
        "--out",
        firstOut,
      ]).status
    ).toBe(0);
    truncateSync(full, 1024);
    const secondOut = join(dir, "second.json");
    expect(
      run([
        "--report",
        "--root",
        dir,
        "--baseline",
        baseline,
        "--out",
        secondOut,
      ]).status
    ).toBe(0);
    const before = JSON.parse(readFileSync(firstOut, "utf8")).artifacts[0];
    const after = JSON.parse(readFileSync(secondOut, "utf8")).artifacts[0];
    expect(before.measured).toBe(4096);
    expect(after.measured).toBe(1024);
  });

  it("deleting a dist file produces a missing-artifact error (VAL-SEC-016)", () => {
    const dir = fixtureDir();
    const artifact = "packages/fixture/dist/index.js";
    writeDistFile(dir, artifact, 128);
    const baseline = writeBudgetFixture(dir, { [artifact]: 128 });
    writeFileSync(join(dir, artifact), ""); // still exists: gate passes
    expect(check(dir, baseline).status).toBe(0);
    const result = run([
      "--check",
      "--root",
      join(dir, "empty-root"),
      "--baseline",
      baseline,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(artifact);
  });

  it("GATE fails on a lowered baseline and reports artifact, measured, baseline, and delta (VAL-SEC-017)", () => {
    const dir = fixtureDir();
    const artifact = "packages/fixture/dist/index.js";
    writeDistFile(dir, artifact, 1000);
    const baseline = writeBudgetFixture(dir, { [artifact]: 100 });
    const result = check(dir, baseline);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(artifact);
    expect(result.stderr).toContain("measured=1000");
    expect(result.stderr).toContain("baseline=100");
    expect(result.stderr).toContain("delta=+900");
  });

  it("the documented tolerance admits small drift but not more (VAL-SEC-017)", () => {
    const dir = fixtureDir();
    const artifact = "packages/fixture/dist/index.js";
    writeDistFile(dir, artifact, 105);
    const baseline = writeBudgetFixture(dir, { [artifact]: 100 }, 5);
    expect(check(dir, baseline).status).toBe(0);
    writeDistFile(dir, artifact, 106);
    const result = check(dir, baseline);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("measured=106");
  });

  it("the committed baseline maps explicit artifact paths to numeric byte ceilings (VAL-SEC-018)", () => {
    const config = JSON.parse(readFileSync(BUNDLE_BASELINE_PATH, "utf8"));
    expect(baselineProblems(config)).toEqual([]);
    const paths = Object.keys(config.artifacts);
    expect(paths).toContain("packages/runtime/dist/evals/cli.js");
    expect(paths).toContain("packages/runtime/dist/");
    expect(paths).toContain("apps/coding-agent/dist/");
    expect(paths.some((p) => p.startsWith("packages/runtime/dist/"))).toBe(
      true
    );
    expect(paths.some((p) => p.startsWith("apps/coding-agent/dist/"))).toBe(
      true
    );
    for (const [path, bytes] of Object.entries(config.artifacts)) {
      expect(path, path).not.toMatch(WILDCARD_PATTERN);
      expect(Number.isInteger(bytes), path).toBe(true);
      expect(bytes, path).toBeGreaterThan(0);
    }
  });

  it("baselineProblems rejects wildcard paths and non-numeric ceilings (VAL-SEC-018)", () => {
    expect(
      baselineProblems({
        version: 1,
        tolerancePercent: 5,
        artifacts: { "packages/runtime/dist/*.js": 100 },
      }).length
    ).toBeGreaterThan(0);
    expect(
      baselineProblems({
        version: 1,
        tolerancePercent: 5,
        artifacts: { "packages/runtime/dist/index.js": "+10%" },
      }).length
    ).toBeGreaterThan(0);
  });

  it("GATE exits non-zero naming the expected path when dist is absent (VAL-SEC-019)", () => {
    const dir = fixtureDir();
    const artifact = "packages/fixture/dist/index.js";
    const baseline = writeBudgetFixture(dir, { [artifact]: 100 });
    const result = check(dir, baseline);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISSING");
    expect(result.stderr).toContain(artifact);
    expect(result.stderr).toContain("pnpm build");
  });

  it("GATE fails on a malformed or unreadable baseline file", () => {
    const dir = fixtureDir();
    const artifact = "packages/fixture/dist/index.js";
    writeDistFile(dir, artifact, 100);
    const missing = check(dir, join(dir, "missing.json"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("baseline");
    const malformed = writeJsonFixture(dir, "bad.json", {
      artifacts: { [artifact]: 100 },
    });
    const result = check(dir, malformed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("baseline");
  });

  it("unknown options exit 2 with usage", () => {
    const result = run(["--nope"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});
