import { describe, expect, it } from "vitest";
import {
  CI_WORKFLOW_PATH,
  costSeparationProblems,
  fastGateProblems,
} from "./ci-fast-gate.mjs";
import { readWorkflows } from "./report-hygiene.mjs";

// Fast-gate wiring and cost-separation invariants (VAL-SEC-046): ci.yml
// invokes every deterministic check root script in the pinned core order,
// and the expensive checks (CodeQL, gitleaks, ZAP, flaky, storage stress)
// live in their own workflow files, never inline in the fast PR gate.
// All checks are static over committed files and pure string fixtures.

const CORE_RUNS = [
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm build",
  "pnpm api:check",
  "pnpm verify:release",
];

const FAST_RUNS = [
  "pnpm check:workspace-drift --check",
  "pnpm check:unused",
  "pnpm check:duplicates",
  ...CORE_RUNS,
  "pnpm check:bundle-size --check",
  "pnpm test:timing",
];

function ciWorkflow(runs = FAST_RUNS) {
  const steps = runs.map((run) => `      - run: ${run}`).join("\n");
  return {
    path: CI_WORKFLOW_PATH,
    source: `name: CI\non: [push, pull_request]\njobs:\n  checks:\n    steps:\n${steps}\n`,
  };
}

function expensiveWorkflow(path, run, on = "workflow_dispatch") {
  return {
    path,
    source: `name: x\non: ${on}\njobs:\n  job:\n    steps:\n      - run: ${run}\n`,
  };
}

function fullSet(ci = ciWorkflow()) {
  return [
    ci,
    expensiveWorkflow(".github/workflows/codeql.yml", "codeql analyze"),
    expensiveWorkflow(".github/workflows/gitleaks.yml", "gitleaks git"),
    expensiveWorkflow(".github/workflows/zap.yml", "zap-baseline.py -t x"),
    expensiveWorkflow(
      ".github/workflows/flaky-tests.yml",
      "pnpm test:flaky -- --runs 5 --timeout 300"
    ),
    expensiveWorkflow(
      ".github/workflows/extended-verification.yml",
      "pnpm stress:runtime-storage:heavy"
    ),
  ];
}

describe("fast gate: deterministic checks wired into ci.yml (VAL-SEC-046)", () => {
  it("shipped workflows satisfy the fast-gate and cost-separation invariants", () => {
    const workflows = readWorkflows();
    expect(fastGateProblems(workflows)).toEqual([]);
    expect(costSeparationProblems(workflows)).toEqual([]);
  });

  it("fails when ci.yml drops the workspace drift gate", () => {
    const runs = FAST_RUNS.filter((run) => !run.includes("workspace-drift"));
    const problems = fastGateProblems([ciWorkflow(runs)]);
    expect(problems.some((p) => p.includes("check:workspace-drift"))).toBe(
      true
    );
  });

  it("fails when ci.yml drops the bundle budget gate", () => {
    const runs = FAST_RUNS.filter((run) => !run.includes("bundle-size"));
    const problems = fastGateProblems([ciWorkflow(runs)]);
    expect(problems.some((p) => p.includes("check:bundle-size"))).toBe(true);
  });

  it("fails when a gate is invoked without its --check mode", () => {
    const runs = FAST_RUNS.map((run) =>
      run.includes("workspace-drift") ? "pnpm check:workspace-drift" : run
    );
    const problems = fastGateProblems([ciWorkflow(runs)]);
    expect(problems.some((p) => p.includes("check:workspace-drift"))).toBe(
      true
    );
  });

  it("fails when the Knip or jscpd gate is missing", () => {
    const runs = FAST_RUNS.filter(
      (run) =>
        !(run.includes("check:unused") || run.includes("check:duplicates"))
    );
    const problems = fastGateProblems([ciWorkflow(runs)]);
    expect(problems.some((p) => p.includes("Knip"))).toBe(true);
    expect(problems.some((p) => p.includes("jscpd"))).toBe(true);
  });

  it("fails when the documentation-carrying test step or test timing is missing", () => {
    const runs = FAST_RUNS.filter(
      (run) => run !== "pnpm test" && !run.includes("test:timing")
    );
    const problems = fastGateProblems([ciWorkflow(runs)]);
    expect(problems.some((p) => p.includes("documentation invariants"))).toBe(
      true
    );
    expect(problems.some((p) => p.includes("test:timing"))).toBe(true);
  });

  it("fails when the pre-existing core step order is broken", () => {
    const swapped = { "pnpm build": "pnpm test", "pnpm test": "pnpm build" };
    const runs = FAST_RUNS.map((run) => swapped[run] ?? run);
    const problems = fastGateProblems([ciWorkflow(runs)]);
    expect(problems.some((p) => p.includes("core step order is pinned"))).toBe(
      true
    );
  });

  it("fails when the bundle budget gate runs before the build", () => {
    const runs = [
      "pnpm check:bundle-size --check",
      ...FAST_RUNS.filter((run) => !run.includes("bundle-size")),
    ];
    const problems = fastGateProblems([ciWorkflow(runs)]);
    expect(problems.some((p) => p.includes("before"))).toBe(true);
  });

  it("fails when ci.yml is absent from the workflow set", () => {
    expect(fastGateProblems([]).some((p) => p.includes("missing"))).toBe(true);
  });
});

describe("cost separation: expensive checks never inline in ci.yml (VAL-SEC-046)", () => {
  it("fails when ci.yml carries a ZAP step", () => {
    const ci = ciWorkflow([...FAST_RUNS, "zap-baseline.py -t https://x"]);
    const problems = costSeparationProblems(fullSet(ci));
    expect(
      problems.some((p) => p.includes("ZAP") && p.includes("ci.yml"))
    ).toBe(true);
  });

  it("fails when ci.yml carries a flaky or storage-stress step", () => {
    const flaky = ciWorkflow([...FAST_RUNS, "pnpm test:flaky -- --runs 5"]);
    expect(
      costSeparationProblems(fullSet(flaky)).some((p) =>
        p.includes("flaky detection")
      )
    ).toBe(true);
    const stress = ciWorkflow([
      ...FAST_RUNS,
      "pnpm stress:runtime-storage:heavy",
    ]);
    expect(
      costSeparationProblems(fullSet(stress)).some((p) =>
        p.includes("storage stress")
      )
    ).toBe(true);
  });

  it("fails when an expensive check has no home workflow at all", () => {
    const workflows = fullSet().filter(({ path }) => !path.includes("zap"));
    const problems = costSeparationProblems(workflows);
    expect(
      problems.some((p) => p.includes("ZAP") && p.includes("no workflow"))
    ).toBe(true);
  });

  it("fails when an expensive check is spread across two workflow files", () => {
    const workflows = [
      ...fullSet(),
      expensiveWorkflow(".github/workflows/zap-copy.yml", "zap-baseline.py"),
    ];
    const problems = costSeparationProblems(workflows);
    expect(problems.some((p) => p.includes("exactly one"))).toBe(true);
  });
});
