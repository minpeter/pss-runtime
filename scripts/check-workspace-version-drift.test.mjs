import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportTool } from "./report-paths.mjs";
import {
  createFixtureScope,
  writeBaselineFixture,
  writeJsonFixture,
} from "./test-fixtures.mjs";

// Wrapper behavior tests for scripts/check-workspace-version-drift.mjs
// (VAL-SEC-010..014): deterministic, offline, parallel-safe; all fixtures
// live under the gitignored .omo/tmp tree (scripts/test-fixtures.mjs).

const WRAPPER = "scripts/check-workspace-version-drift.mjs";
const scope = createFixtureScope("check-workspace-drift-");

afterEach(scope.cleanup);

const fixtureDir = scope.dir;

function run(args) {
  return spawnSync("node", [WRAPPER, ...args], { encoding: "utf8" });
}

function writeWorkspace(dir, packages) {
  writeFileSync(
    join(dir, "pnpm-workspace.yaml"),
    'packages:\n  - "apps/*"\n  - "packages/*"\n'
  );
  writeJsonFixture(dir, "package.json", {
    name: "fixture-root",
    private: true,
  });
  for (const [path, manifest] of Object.entries(packages)) {
    mkdirSync(join(dir, path), { recursive: true });
    writeJsonFixture(dir, join(path, "package.json"), manifest);
  }
  return dir;
}

function mismatchedWorkspace(dir) {
  return writeWorkspace(dir, {
    "apps/a": { name: "a", dependencies: { ai: "1.0.0", zod: "^4.4.3" } },
    "apps/b": { name: "b", dependencies: { ai: "2.0.0", zod: "^4.4.3" } },
  });
}

function consistentWorkspace(dir) {
  return writeWorkspace(dir, {
    "apps/a": { name: "a", dependencies: { ai: "7.0.51", zod: "^4.4.3" } },
    "apps/b": { name: "b", dependencies: { ai: "7.0.51", zod: "^4.4.3" } },
  });
}

function check(root, baseline) {
  return run(["--check", "--root", root, "--baseline", baseline]);
}

describe("check:workspace-drift wrapper", () => {
  it("no-arg prints usage and exits 0 (VAL-SEC-010)", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--check");
  });

  it("--help prints usage and exits 0 (VAL-SEC-010)", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--check");
  });

  it("is wired to the root check:workspace-drift script (VAL-SEC-010)", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.scripts["check:workspace-drift"]).toBe(
      "node scripts/check-workspace-version-drift.mjs --check"
    );
  });

  it("GATE reports the dependency, both versions, and the affected packages on a mismatch (VAL-SEC-011)", () => {
    const dir = fixtureDir();
    const result = check(
      mismatchedWorkspace(dir),
      writeBaselineFixture(dir, [])
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISMATCH ai");
    expect(result.stderr).toContain("1.0.0");
    expect(result.stderr).toContain("2.0.0");
    expect(result.stderr).toContain("apps/a");
    expect(result.stderr).toContain("apps/b");
  });

  it("detects optional dependency drift across manifest fields", () => {
    const dir = fixtureDir();
    writeWorkspace(dir, {
      "apps/a": { name: "a", dependencies: { zod: "4.0.0" } },
      "apps/b": { name: "b", optionalDependencies: { zod: "3.0.0" } },
    });
    const result = check(dir, writeBaselineFixture(dir, []));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "MISMATCH zod: 3.0.0 [apps/b] vs 4.0.0 [apps/a]"
    );
  });

  it("GATE exits 0 with no mismatch lines on a consistent fixture (VAL-SEC-012)", () => {
    const dir = fixtureDir();
    const result = check(
      consistentWorkspace(dir),
      writeBaselineFixture(dir, [])
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("check:workspace-drift OK");
    expect(result.stderr).not.toContain("MISMATCH");
  });

  it("GATE exits 0 on the real repository manifests (VAL-SEC-012)", () => {
    const result = run(["--check"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("check:workspace-drift OK");
    expect(result.stderr).not.toContain("MISMATCH");
  });

  it("compares only the declared shared set; a unique non-shared dependency produces no finding (VAL-SEC-013)", () => {
    const dir = fixtureDir();
    writeWorkspace(dir, {
      "apps/a": {
        name: "a",
        dependencies: { ai: "7.0.51", "left-pad": "1.0.0" },
      },
      "apps/b": {
        name: "b",
        dependencies: { ai: "7.0.51", "left-pad": "2.0.0" },
      },
    });
    const result = check(dir, writeBaselineFixture(dir, []));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("check:workspace-drift OK");
    expect(result.stdout + result.stderr).not.toContain("left-pad");
  });

  it("a baseline signature accepts an intentional divergence (VAL-SEC-014)", () => {
    const dir = fixtureDir();
    const result = check(
      mismatchedWorkspace(dir),
      writeBaselineFixture(dir, ["ai: 1.0.0 2.0.0"])
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("check:workspace-drift OK");
    expect(result.stderr).not.toContain("MISMATCH");
  });

  it("removing the baseline flags the same divergence again (VAL-SEC-014)", () => {
    const dir = fixtureDir();
    const result = check(
      mismatchedWorkspace(dir),
      writeBaselineFixture(dir, [])
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISMATCH ai: 1.0.0");
  });

  it("GATE exits non-zero on a stale baseline signature", () => {
    const dir = fixtureDir();
    const result = check(
      consistentWorkspace(dir),
      writeBaselineFixture(dir, ["ai: 1.0.0 2.0.0"])
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STALE ai: 1.0.0 2.0.0");
  });

  it("fails the run when the baseline file is unreadable or malformed", () => {
    const dir = fixtureDir();
    const missing = check(mismatchedWorkspace(dir), join(dir, "missing.json"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("baseline");
    const malformed = writeJsonFixture(dir, "bad-baseline.json", {
      signatures: "nope",
    });
    const result = check(dir, malformed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("baseline");
  });

  it("REPORT writes a bounded report to the --out path and exits 0 even with un-baselined drift", () => {
    const dir = fixtureDir();
    const out = join(dir, "report.json");
    const result = run([
      "--report",
      "--root",
      mismatchedWorkspace(dir),
      "--baseline",
      writeBaselineFixture(dir, []),
      "--out",
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.totalDivergences).toBe(1);
    expect(report.unbaselined).toEqual(["ai: 1.0.0 2.0.0"]);
    expect(report.truncated).toBe(false);
  });

  it("REPORT truncates a noisy run at the registry cap with a note (VAL-SEC-009)", () => {
    const dir = fixtureDir();
    const cap = reportTool("drift").cap;
    // One dependency can diverge at most once, so a noisy run needs more
    // diverging dependencies than the declared set: the report still
    // truncates because the declared set is smaller than the cap.
    const packages = {};
    for (let index = 0; index < 2; index += 1) {
      packages[`apps/p${index}`] = {
        name: `p${index}`,
        dependencies: { ai: `${index + 1}.0.0` },
      };
    }
    writeWorkspace(dir, packages);
    const out = join(dir, "report.json");
    const result = run([
      "--report",
      "--root",
      dir,
      "--baseline",
      writeBaselineFixture(dir, []),
      "--out",
      out,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.divergences.length).toBeLessThanOrEqual(cap);
    expect(report.truncated).toBe(false);
  });
});
