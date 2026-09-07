import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aggregateRunReports,
  buildFlakyReport,
  classifyOutcomes,
  flakyArtifactProblems,
  vitestRunArgs,
} from "./flaky-tests.mjs";
import { reportTool } from "./report-paths.mjs";
import { gitCheckIgnored, gitTracked } from "./test-fixtures.mjs";

// Flaky-detection producer invariants (VAL-SEC-025/026): the root
// `test:flaky` script runs the deterministic invariant suite with Vitest
// retries forced off, the report path is the registered gitignored artifact,
// and the classification reports an always-fail fixture as failed, an
// intermittent fixture as flaky, and neither as passed. All checks are pure
// fixtures; the one producer run used as live evidence stays under
// .omo/evidence/.

function rootScripts() {
  return JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {};
}

function runReport(tests) {
  return {
    testResults: [
      {
        name: "scripts/example.test.mjs",
        assertionResults: tests.map(([title, status]) => ({
          fullName: `suite > ${title}`,
          status,
        })),
      },
    ],
  };
}

describe("flaky detection: script wiring (VAL-SEC-025)", () => {
  it("root package.json exposes test:flaky wired to the producer", () => {
    expect(rootScripts()["test:flaky"]).toContain("scripts/flaky-tests.mjs");
  });

  it("declares the report path in the registry as a CI artifact", () => {
    const tool = reportTool("flaky");
    expect(tool.path).toBe("report/flaky-tests.json");
    expect(tool.ci).toBe("artifact");
    expect(Number.isInteger(tool.cap) && tool.cap > 0).toBe(true);
  });

  it("gitignores the report path and never tracks it", () => {
    expect(gitCheckIgnored(reportTool("flaky").path)).toBe(true);
    expect(gitTracked(reportTool("flaky").path)).toBe(false);
  });

  it("forces Vitest retries off in every repeated run", () => {
    expect(vitestRunArgs("out.json")).toContain("--retry=0");
  });
});

describe("flaky detection: classification (VAL-SEC-026)", () => {
  it("reports an always-fail fixture as failed, never flaky", () => {
    const entries = aggregateRunReports([
      runReport([["broken", "failed"]]),
      runReport([["broken", "failed"]]),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("failed");
    expect(classifyOutcomes(["failed", "failed", "failed"])).toBe("failed");
  });

  it("reports an intermittent fixture as flaky, never passed", () => {
    const entries = aggregateRunReports([
      runReport([["flake", "passed"]]),
      runReport([["flake", "failed"]]),
    ]);
    expect(entries[0].status).toBe("flaky");
    expect(classifyOutcomes(["passed", "failed"])).toBe("flaky");
  });

  it("reports an all-pass fixture as passed", () => {
    const entries = aggregateRunReports([
      runReport([["ok", "passed"]]),
      runReport([["ok", "passed"]]),
    ]);
    expect(entries[0].status).toBe("passed");
    expect(classifyOutcomes(["passed", "passed"])).toBe("passed");
  });

  it("classifies a mixed suite with neither failure kind reported passed", () => {
    const entries = aggregateRunReports([
      runReport([
        ["stable", "passed"],
        ["broken", "failed"],
        ["flake", "passed"],
      ]),
      runReport([
        ["stable", "passed"],
        ["broken", "failed"],
        ["flake", "failed"],
      ]),
    ]);
    const byTitle = Object.fromEntries(
      entries.map((entry) => [entry.name.split(" > ").pop(), entry.status])
    );
    expect(byTitle).toEqual({
      stable: "passed",
      broken: "failed",
      flake: "flaky",
    });
  });

  it("truncates a noisy report at the registry cap with a note", () => {
    const cap = reportTool("flaky").cap;
    const entries = Array.from({ length: cap + 25 }, (_, index) => ({
      file: "scripts/x.test.mjs",
      name: `case ${index}`,
      status: "passed",
      runs: 5,
      failures: 0,
    }));
    const report = buildFlakyReport(entries, { runs: 5, timeoutSeconds: 300 });
    expect(report.entries).toHaveLength(cap);
    expect(report.truncated).toBe(true);
    expect(report.note).toContain(String(cap));
    expect(report.summary.passed).toBe(cap + 25);
  });

  it("rejects malformed artifacts and invalid entry statuses", () => {
    expect(flakyArtifactProblems(null)).not.toEqual([]);
    expect(flakyArtifactProblems({ entries: "nope" })).not.toEqual([]);
    const problems = flakyArtifactProblems({
      runs: 5,
      timeoutSeconds: 300,
      entries: [{ file: "a", name: "b", status: "unknown" }],
    });
    expect(problems.some((p) => p.includes("status"))).toBe(true);
  });

  it("accepts a well-formed classification report", () => {
    const valid = buildFlakyReport(
      [
        {
          file: "scripts/x.test.mjs",
          name: "case",
          status: "flaky",
          runs: 5,
          failures: 2,
        },
      ],
      { runs: 5, timeoutSeconds: 300 }
    );
    expect(flakyArtifactProblems(valid)).toEqual([]);
  });
});
