import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureScope } from "./test-fixtures.mjs";

const scope = createFixtureScope("timing-producer-");
const producer = resolve("scripts/test-timing.mjs");
const diagnosticPrefix = "test:timing failures: ";

afterEach(() => scope.cleanup());

function runProducer({
  status = 0,
  failures = 0,
  writeReport = true,
  stale = false,
} = {}) {
  const cwd = resolve(scope.dir());
  const tmpdir = join(cwd, "caller-tmp");
  mkdirSync(tmpdir);
  mkdirSync(join(cwd, "scripts"));
  writeFileSync(join(cwd, "scripts/example.test.mjs"), "");
  mkdirSync(join(cwd, "node_modules/vitest"), { recursive: true });
  if (stale) {
    mkdirSync(join(cwd, ".omo/tmp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omo/tmp/test-timing.vitest.json"),
      JSON.stringify({
        testResults: [
          {
            name: "stale",
            assertionResults: [
              { fullName: "stale", duration: 1, status: "passed" },
            ],
          },
        ],
      })
    );
  }
  // Replace only the expensive runner, not the producer's process boundary,
  // environment, JSON parsing, artifact writing, or exit-status propagation.
  writeFileSync(
    join(cwd, "node_modules/vitest/vitest.mjs"),
    `import { writeFileSync } from "node:fs";
const out = process.argv.find(arg => arg.startsWith("--outputFile=")).slice(13);
writeFileSync("child-env.json", JSON.stringify({ TMPDIR: process.env.TMPDIR, out }));
if (${writeReport}) writeFileSync(out, JSON.stringify({ testResults: [{
  name: process.cwd() + "/scripts/example.test.mjs",
  assertionResults: Array.from({ length: ${Math.max(1, failures)} }, (_, index) => ({
    fullName: "case " + index + "\\n" + "x".repeat(400),
    status: index < ${failures} ? "failed" : "passed",
    duration: 1,
    failureMessages: ["PRIVATE_ASSERTION_PAYLOAD"]
  }))
}] }));
console.error("PRIVATE_CHILD_STDERR");
console.log("PRIVATE_CHILD_STDOUT");
process.exit(${status});
`
  );
  const result = spawnSync(process.execPath, [producer], {
    cwd,
    env: { ...process.env, TMPDIR: tmpdir },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return {
    ...result,
    tmpdir,
    scratch: readdirSync(join(cwd, ".omo/tmp")),
    childEnv: JSON.parse(readFileSync(join(cwd, "child-env.json"), "utf8")),
    artifact: existsSync(join(cwd, "report/test-timing.json"))
      ? JSON.parse(readFileSync(join(cwd, "report/test-timing.json"), "utf8"))
      : null,
  };
}

describe("test timing: producer process boundary", () => {
  it("inherits TMPDIR instead of moving suite fixtures into the checkout", () => {
    const result = runProducer();
    expect(result.status).toBe(0);
    expect(result.childEnv.TMPDIR).toBe(result.tmpdir);
    expect(result.artifact.entries).toHaveLength(1);
    expect(result.scratch).toEqual([]);
    expect(existsSync(result.childEnv.out)).toBe(false);
  });

  it.each([0, 3])(
    "never consumes a stale raw report when the runner exits %s without writing",
    (status) => {
      const result = runProducer({ status, writeReport: false, stale: true });
      expect(result.status).toBe(1);
      expect(result.artifact).toBeNull();
      expect(result.scratch).toEqual(["test-timing.vitest.json"]);
      expect(existsSync(result.childEnv.out)).toBe(false);
    }
  );

  it("preserves a failing status and artifact with bounded identifiers, not raw errors", () => {
    const result = runProducer({ status: 3, failures: 15 });
    expect(result.status).toBe(3);
    expect(result.scratch).toEqual([]);
    expect(result.artifact.entries).toHaveLength(15);
    expect(
      result.artifact.entries.every((entry) => entry.status === "failed")
    ).toBe(true);
    const line = result.stderr
      .split("\n")
      .find((value) => value.startsWith(diagnosticPrefix));
    expect(line).toBeDefined();
    const diagnostic = JSON.parse(line.slice(diagnosticPrefix.length));
    expect(diagnostic.total).toBe(15);
    expect(diagnostic.tests).toHaveLength(10);
    expect(diagnostic.tests[0].file).toBe("scripts/example.test.mjs");
    expect(diagnostic.tests[0].name.startsWith("case 0")).toBe(true);
    expect(
      diagnostic.tests.every(
        (test) => test.name.length <= 200 && test.file.length <= 200
      )
    ).toBe(true);
    expect(result.stderr.length).toBeLessThan(4000);
    expect(result.stderr + result.stdout).not.toContain("PRIVATE_");
  });
});
