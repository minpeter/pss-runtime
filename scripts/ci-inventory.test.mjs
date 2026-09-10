import { describe, expect, it } from "vitest";
import {
  CI_INVENTORY_WORKFLOW,
  driftAlongsideProblems,
  FAST_GATE_STEPS,
  fastGateStepOrderProblems,
  WORKFLOW_CLASSES,
  workflowClassProblems,
} from "./ci-inventory.mjs";
import { readWorkflows } from "./report-hygiene.mjs";

// CI fast-gate inventory invariants (VAL-CROSS-004/006): the ci.yml job
// `checks` keeps the twelve documented fast-gate steps in their pinned
// relative order, every workflow file carries a documented
// deterministic/scheduled/manual/bounded classification, and the workspace
// drift gate accompanies — never substitutes for — the package-boundary and
// release verification gates. All checks are static over committed files
// and pure string fixtures.

function namedStepsYaml(names) {
  return names.map((name) => `      - name: ${name}`).join("\n");
}

function ciWorkflow(stepNames = FAST_GATE_STEPS, extraSteps = []) {
  const extra = extraSteps
    .map((run) => `      - name: extra\n        run: ${run}`)
    .join("\n");
  const base = namedStepsYaml(stepNames);
  return {
    path: CI_INVENTORY_WORKFLOW,
    source: `name: CI\non: [push, pull_request, workflow_dispatch]\njobs:\n  checks:\n    steps:\n${base}${extra === "" ? "" : `\n${extra}`}\n`,
  };
}

function classWorkflow(triggers, timeout = 30) {
  const list = triggers.map((trigger) => `"${trigger}"`).join(", ");
  const bound = timeout === null ? "" : `    timeout-minutes: ${timeout}\n`;
  return `name: x\non: [${list}]\njobs:\n  job:\n${bound}    steps: []\n`;
}

function classSet(overrides = {}) {
  return WORKFLOW_CLASSES.map((entry) => ({
    path: entry.path,
    source:
      overrides[entry.path] ??
      classWorkflow([...entry.require], entry.bounded ? 30 : null),
  }));
}

describe("fast-gate step order (VAL-CROSS-004)", () => {
  it("shipped workflows satisfy the inventory invariants", () => {
    const workflows = readWorkflows();
    expect(fastGateStepOrderProblems(workflows)).toEqual([]);
    expect(workflowClassProblems(workflows)).toEqual([]);
    expect(driftAlongsideProblems(workflows)).toEqual([]);
  });

  it("documents exactly the twelve pinned fast-gate steps", () => {
    expect(FAST_GATE_STEPS).toEqual([
      "Install dependencies",
      "Audit dependencies",
      "Check package boundaries",
      "Validate Pi compatibility manifest",
      "Check tegami entry sections",
      "Lint",
      "Typecheck",
      "Test",
      "Check core package coverage",
      "Build",
      "Check runtime public API snapshot",
      "Verify release artifacts",
    ]);
  });

  it("fails when a documented fast-gate step is dropped", () => {
    const names = FAST_GATE_STEPS.filter(
      (name) => name !== "Check tegami entry sections"
    );
    const problems = fastGateStepOrderProblems([ciWorkflow(names)]);
    expect(
      problems.some((p) => p.includes("Check tegami entry sections"))
    ).toBe(true);
  });

  it("fails when the documented relative order is broken", () => {
    const swapped = { Build: "Test", Test: "Build" };
    const names = FAST_GATE_STEPS.map((name) => swapped[name] ?? name);
    const problems = fastGateStepOrderProblems([ciWorkflow(names)]);
    expect(problems.some((p) => p.includes("relative order"))).toBe(true);
  });

  it("fails when a documented step is repeated", () => {
    const problems = fastGateStepOrderProblems([
      ciWorkflow([...FAST_GATE_STEPS, "Lint"]),
    ]);
    expect(problems.some((p) => p.includes('"Lint"'))).toBe(true);
  });

  it("accepts additive steps between the documented ones", () => {
    const names = [
      "Install dependencies",
      "Check workspace version drift",
      ...FAST_GATE_STEPS.slice(1),
    ];
    expect(fastGateStepOrderProblems([ciWorkflow(names)])).toEqual([]);
  });

  it("fails when ci.yml is absent from the workflow set", () => {
    expect(
      fastGateStepOrderProblems([]).some((p) => p.includes("missing"))
    ).toBe(true);
  });
});

describe("workflow classification (VAL-CROSS-004)", () => {
  it("fails on an unclassified workflow file", () => {
    const workflows = [
      ...classSet(),
      {
        path: ".github/workflows/mystery.yml",
        source: classWorkflow(["push"]),
      },
    ];
    const problems = workflowClassProblems(workflows);
    expect(problems.some((p) => p.includes("mystery.yml"))).toBe(true);
  });

  it("fails when a workflow loses a trigger its class requires", () => {
    const problems = workflowClassProblems(
      classSet({ ".github/workflows/zap.yml": classWorkflow(["push"]) })
    );
    expect(
      problems.some(
        (p) => p.includes("zap.yml") && p.includes("workflow_dispatch")
      )
    ).toBe(true);
  });

  it("fails when a scheduled/manual class gains a fast-CI trigger", () => {
    const problems = workflowClassProblems(
      classSet({
        ".github/workflows/flaky-tests.yml": classWorkflow([
          "schedule",
          "workflow_dispatch",
          "pull_request",
        ]),
      })
    );
    expect(
      problems.some(
        (p) => p.includes("flaky-tests.yml") && p.includes("pull_request")
      )
    ).toBe(true);
  });

  it("fails when a bounded analysis job drops its timeout", () => {
    const problems = workflowClassProblems(
      classSet({
        ".github/workflows/codeql.yml": classWorkflow(
          ["pull_request", "push", "schedule", "workflow_dispatch"],
          null
        ),
      })
    );
    expect(
      problems.some(
        (p) => p.includes("codeql.yml") && p.includes("timeout-minutes")
      )
    ).toBe(true);
  });

  it("fails when a classified workflow file is missing", () => {
    const workflows = classSet().filter(
      ({ path }) => !path.includes("gitleaks")
    );
    expect(
      workflowClassProblems(workflows).some((p) => p.includes("gitleaks.yml"))
    ).toBe(true);
  });
});

describe("drift accompanies, never substitutes (VAL-CROSS-006)", () => {
  const DRIFT = "pnpm check:workspace-drift --check";
  const BOUNDARIES = "pnpm boundaries";
  const VERIFY = "pnpm verify:release";

  it("passes when drift runs alongside boundary and release gates", () => {
    expect(
      driftAlongsideProblems([
        ciWorkflow(FAST_GATE_STEPS, [DRIFT, BOUNDARIES, VERIFY]),
      ])
    ).toEqual([]);
  });

  it("fails when drift replaces the package-boundary gate", () => {
    const problems = driftAlongsideProblems([
      ciWorkflow(FAST_GATE_STEPS, [DRIFT, VERIFY]),
    ]);
    expect(problems.some((p) => p.includes("boundaries"))).toBe(true);
  });

  it("fails when drift replaces the release verification gate", () => {
    const problems = driftAlongsideProblems([
      ciWorkflow(FAST_GATE_STEPS, [DRIFT, BOUNDARIES]),
    ]);
    expect(problems.some((p) => p.includes("verify:release"))).toBe(true);
  });

  it("fails when the drift gate itself is dropped", () => {
    const problems = driftAlongsideProblems([
      ciWorkflow(FAST_GATE_STEPS, [BOUNDARIES, VERIFY]),
    ]);
    expect(problems.some((p) => p.includes("drift"))).toBe(true);
  });
});
