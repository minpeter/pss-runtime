import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureScope } from "./test-fixtures.mjs";

const scope = createFixtureScope("flaky-producer-");
const producer = resolve("scripts/flaky-tests.mjs");

afterEach(() => scope.cleanup());

describe("flaky producer process boundary", () => {
  it("inherits OS temp while isolating and cleaning repeated-run reports", () => {
    const cwd = resolve(scope.dir());
    const callerTemp = tmpdir();
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts/fixture.test.mjs"), "");
    mkdirSync(join(cwd, "node_modules/vitest"), { recursive: true });
    // Replace only Vitest: the shipped producer still owns the child env,
    // report paths, repeated runs, validation, aggregation, and cleanup.
    writeFileSync(
      join(cwd, "node_modules/vitest/vitest.mjs"),
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const out = process.argv.find(arg => arg.startsWith("--outputFile=")).slice(13);
const observations = existsSync("child.json")
  ? JSON.parse(readFileSync("child.json", "utf8")) : [];
observations.push({ TMPDIR: process.env.TMPDIR, temp: tmpdir(), out, stale: existsSync(out) });
writeFileSync("child.json", JSON.stringify(observations));
writeFileSync(out, JSON.stringify({
  success: true,
  numTotalTests: 3,
  testResults: [{
    name: "scripts/fixture.test.mjs",
    status: "passed",
    assertionResults: ["passed", "skipped", "todo"].map(status => ({ fullName: status, status }))
  }]
}));
`
    );
    const result = spawnSync(
      process.execPath,
      [producer, "--runs", "2", "--timeout", "10", "--out", "result.json"],
      {
        cwd,
        env: { ...process.env, TMPDIR: callerTemp },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observations = JSON.parse(
      readFileSync(join(cwd, "child.json"), "utf8")
    );
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(observation.TMPDIR).toBe(callerTemp);
      expect(observation.temp).toBe(callerTemp);
      expect(observation.stale).toBe(false);
      expect(dirname(dirname(observation.out))).toBe(join(cwd, ".omo/tmp"));
      expect(existsSync(observation.out)).toBe(false);
    }
    expect(observations[0].out).not.toBe(observations[1].out);
    expect(readdirSync(join(cwd, ".omo/tmp"))).toEqual([]);
    const report = JSON.parse(readFileSync(join(cwd, "result.json"), "utf8"));
    expect(report.incomplete).toBe(false);
    expect(report.summary).toEqual({
      passed: 1,
      flaky: 0,
      failed: 0,
      skipped: 1,
      todo: 1,
      incomplete: 0,
    });
    expect(report.entries).toHaveLength(3);
    expect(report.entries.every((entry) => entry.runs === 2)).toBe(true);
  });
});
