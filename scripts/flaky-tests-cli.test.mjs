import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const producer = resolve("scripts/flaky-tests.mjs");
const dependencies = resolve("node_modules");

function runFixture({ reports, status = 0, source, runs = 1 }) {
  mkdirSync(".omo/tmp", { recursive: true });
  const cwd = mkdtempSync(resolve(".omo/tmp/flaky-cli-"));
  try {
    mkdirSync(`${cwd}/scripts`);
    writeFileSync(`${cwd}/scripts/fixture.test.mjs`, source ?? "");
    if (source) {
      symlinkSync(dependencies, `${cwd}/node_modules`, "dir");
    } else {
      mkdirSync(`${cwd}/node_modules/vitest`, { recursive: true });
      writeFileSync(
        `${cwd}/node_modules/vitest/vitest.mjs`,
        `
        import { readFileSync, writeFileSync, existsSync } from 'node:fs';
        const index = existsSync('count') ? Number(readFileSync('count', 'utf8')) : 0;
        writeFileSync('count', String(index + 1));
        const report = ${JSON.stringify(reports)}[index];
        const out = process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13);
        if (report !== null) writeFileSync(out, JSON.stringify(report));
        process.exit(${status});
      `
      );
    }
    const result = spawnSync(
      process.execPath,
      [
        producer,
        "--runs",
        String(runs),
        "--timeout",
        "10",
        "--out",
        "result.json",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      report: JSON.parse(readFileSync(`${cwd}/result.json`, "utf8")),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function report(statuses = ["passed"]) {
  return {
    success: !statuses.includes("failed"),
    numTotalTests: statuses.length,
    testResults: [
      {
        name: "scripts/fixture.test.mjs",
        status: statuses.includes("failed") ? "failed" : "passed",
        assertionResults: statuses.map((status, index) => ({
          fullName: `case ${index}`,
          status,
        })),
      },
    ],
  };
}

describe("flaky CLI report integrity", () => {
  it.each([
    {},
    { testResults: [] },
    {
      testResults: [{ name: "scripts/fixture.test.mjs", assertionResults: [] }],
    },
  ])("rejects empty or incomplete child reports: %j", (value) => {
    expect(runFixture({ reports: [value], status: 1 }).status).toBe(1);
  });

  it("rejects nonzero child status even when every reported assertion passes", () => {
    const result = runFixture({ reports: [report()], status: 1 });
    expect(result.status).toBe(1);
    expect(result.report.incomplete).toBe(true);
  });

  it("rejects missing reports without treating a missing run as a pass", () => {
    const result = runFixture({ reports: [report(), null], runs: 2 });
    expect(result.status).toBe(1);
    expect(result.report.entries[0]).toMatchObject({
      runs: 2,
      status: "incomplete",
    });
  });

  it("rejects omitted requested files and suite errors even on a zero child exit", () => {
    const partial = report();
    partial.testResults[0].name = "scripts/other.test.mjs";
    expect(runFixture({ reports: [partial] }).status).toBe(1);
    expect(
      runFixture({ reports: [{ ...report(), success: false }] }).status
    ).toBe(1);
    expect(
      runFixture({ reports: [{ ...report(), numRuntimeErrorTestSuites: 1 }] })
        .status
    ).toBe(1);
  });

  it("rejects inconsistent totals and missing entries across runs", () => {
    expect(
      runFixture({ reports: [{ ...report(), numTotalTests: 2 }] }).status
    ).toBe(1);
    const result = runFixture({
      reports: [report(["passed", "passed"]), report()],
      runs: 2,
    });
    expect(result.status).toBe(1);
    expect(
      result.report.entries.find((entry) => entry.name === "case 1").status
    ).toBe("incomplete");
  });

  it.each(["skipped", "pending", "todo"])(
    "does not count legitimate %s outcomes as passed or fail the command",
    (status) => {
      const result = runFixture({ reports: [report([status])] });
      expect(result.status).toBe(0);
      expect(result.report.summary.passed).toBe(0);
      expect(
        result.report.summary[status === "pending" ? "skipped" : status]
      ).toBe(1);
    }
  );

  it("rejects unknown outcomes and keeps them out of passed counts", () => {
    const result = runFixture({ reports: [report(["unknown"])] });
    expect(result.status).toBe(1);
    expect(result.report.summary.incomplete).toBe(1);
  });

  it("preserves actual mixed pass/fail flakiness", () => {
    const result = runFixture({
      reports: [report(), report(["failed"])],
      runs: 2,
      status: 1,
    });
    expect(result.status).toBe(1);
    expect(result.report.summary.flaky).toBe(1);
  });

  it("rejects a real Vitest collection/import failure", () => {
    const result = runFixture({ source: 'import "./missing-module.mjs";' });
    expect(result.status).toBe(1);
  }, 30_000);

  it("accepts real passing, skipped, and todo Vitest tests without counting skips as passes", () => {
    const result = runFixture({
      source:
        'import { it } from "vitest"; it("passes", () => {}); it.skip("skips", () => {}); it.todo("todo");',
    });
    expect(result.status).toBe(0);
    expect(result.report.summary).toMatchObject({
      passed: 1,
      skipped: 1,
      todo: 1,
    });
  }, 30_000);
});
