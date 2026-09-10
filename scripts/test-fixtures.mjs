import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Shared temp-fixture helpers for the scripts/*.test.mjs wrapper behavior
// tests. All fixtures live under the gitignored .omo/tmp tree (never
// os.tmpdir(): this host's /tmp is over quota) and every created directory
// is removed by scope.cleanup() from the test file's afterEach hook.

// Shared read-only git probes for report-path invariants: ignore coverage
// (check-ignore) and tracked state (ls-files). Read-only query processes;
// nothing here writes.
export function gitCheckIgnored(path) {
  return spawnSync("git", ["check-ignore", "-q", "--", path]).status === 0;
}

export function gitTracked(path) {
  return (
    spawnSync("git", ["ls-files", "--error-unmatch", "--", path], {
      stdio: "ignore",
    }).status === 0
  );
}

export const FIXTURE_BASE = ".omo/tmp";

export function createFixtureScope(prefix) {
  const dirs = [];
  return {
    dir() {
      mkdirSync(FIXTURE_BASE, { recursive: true });
      const dir = mkdtempSync(join(FIXTURE_BASE, prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { force: true, recursive: true });
      }
    },
  };
}

export function writeJsonFixture(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

export function writeBaselineFixture(dir, signatures = []) {
  return writeJsonFixture(dir, "baseline.json", { version: 1, signatures });
}
