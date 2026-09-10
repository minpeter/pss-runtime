import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  flakyCiProblems,
  vitestConfigPaths,
  vitestRetryProblems,
} from "./flaky-ci.mjs";
import { readWorkflows } from "./report-hygiene.mjs";

// Flaky-detection CI and retry invariants (VAL-SEC-025/026): the detection
// workflow is gated to schedule/workflow_dispatch with an explicit numeric
// repeat count and bounded timeouts, the fast CI (pull_request/push) never
// carries a flaky step, and no checked-in Vitest config enables retries.
// All checks are static over committed files and pure fixtures.

function detectionWorkflow({
  triggers = 'on:\n  workflow_dispatch:\n  schedule:\n    - cron: "13 2 * * 1"\n',
  run = "pnpm test:flaky -- --runs 5 --timeout 300",
  timeout = "    timeout-minutes: 30\n",
  upload = `      - if: always()
        uses: actions/upload-artifact@v7
        with: { name: flaky-tests, path: report/flaky-tests.json, retention-days: 7 }
`,
} = {}) {
  return `name: Flaky test detection
${triggers}jobs:
  flaky-detection:
    runs-on: ubuntu-latest
${timeout}    steps:
      - run: ${run}
${upload}`;
}

function problemsOf(...sources) {
  return flakyCiProblems(
    sources.map((source, index) => ({ path: `w${index}.yml`, source }))
  );
}

describe("flaky detection: CI wiring (VAL-SEC-025)", () => {
  it("shipped workflows satisfy the bounded scheduled-detection shape", () => {
    expect(flakyCiProblems(readWorkflows())).toEqual([]);
  });

  it("fails when no workflow step runs the flaky producer", () => {
    const problems = problemsOf(detectionWorkflow({ run: "pnpm test" }));
    expect(problems.some((p) => p.includes("no workflow step"))).toBe(true);
  });

  it("fails when the producer workflow triggers on pull_request", () => {
    const problems = problemsOf(
      detectionWorkflow({ triggers: "on: pull_request\n" })
    );
    expect(problems.some((p) => p.includes("schedule/workflow_dispatch"))).toBe(
      true
    );
  });

  it("fails when the fast CI workflow carries a flaky step", () => {
    const problems = problemsOf(
      detectionWorkflow({ triggers: "on: [push, pull_request]\n" })
    );
    expect(problems.some((p) => p.includes("fast CI"))).toBe(true);
  });

  it("fails when the producer step lacks an explicit numeric repeat count", () => {
    const problems = problemsOf(
      detectionWorkflow({ run: "pnpm test:flaky -- --timeout 300" })
    );
    expect(problems.some((p) => p.includes("--runs"))).toBe(true);
  });

  it("fails when the producer step lacks a bounded per-run timeout", () => {
    const problems = problemsOf(
      detectionWorkflow({ run: "pnpm test:flaky -- --runs 5" })
    );
    expect(problems.some((p) => p.includes("--timeout"))).toBe(true);
  });

  it("fails when the producer job lacks a bounded timeout-minutes", () => {
    const problems = problemsOf(detectionWorkflow({ timeout: "" }));
    expect(problems.some((p) => p.includes("timeout-minutes"))).toBe(true);
  });

  it("fails when no bounded upload-artifact step covers the report", () => {
    const problems = problemsOf(detectionWorkflow({ upload: "" }));
    expect(problems.some((p) => p.includes("upload-artifact"))).toBe(true);
  });
});

describe("flaky detection: Vitest retry stays disabled (VAL-SEC-026)", () => {
  it("finds checked-in Vitest configs and none set retry above zero", () => {
    const paths = vitestConfigPaths();
    expect(paths.length).toBeGreaterThan(0);
    const configs = paths.map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    }));
    expect(vitestRetryProblems(configs)).toEqual([]);
  });

  it("rejects a config with retry greater than zero", () => {
    const problems = vitestRetryProblems([
      {
        path: "pkg/vitest.config.ts",
        source: "export default { test: { retry: 2 } };",
      },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("retry");
  });

  it("accepts an explicit retry of zero and configs without retry", () => {
    expect(
      vitestRetryProblems([
        {
          path: "a/vitest.config.ts",
          source: "export default { test: { retry: 0 } };",
        },
        { path: "b/vitest.config.ts", source: "export default {};" },
      ])
    ).toEqual([]);
  });

  it("rejects a non-literal retry expression that could hide retries", () => {
    const problems = vitestRetryProblems([
      {
        path: "c/vitest.config.ts",
        source: "export default { test: { retry: env.CI_RETRIES } };",
      },
    ]);
    expect(problems).toHaveLength(1);
  });
});
