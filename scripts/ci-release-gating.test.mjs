import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CI_WORKFLOW_PATH } from "./ci-fast-gate.mjs";
import {
  deferredBranchProtectionProblems,
  RELEASE_WORKFLOW,
  releaseSequencingProblems,
  securityVisibilityProblems,
} from "./ci-release-gating.mjs";
import { DEFERRED_DOC } from "./governance-readme.mjs";
import { readWorkflows } from "./report-hygiene.mjs";

// Intra-workflow release gating and security-visibility invariants
// (VAL-CROSS-005/007): the release publish step is sequenced after the
// correctness gates INSIDE the same workflow job, no cross-workflow
// dependency or branch-protection mechanism is used or claimed, security
// scan failures stay visible without any blocking claim, and the clean
// ci.yml path never publishes. Static over committed files and pure string
// fixtures only.

const PREREQUISITE_RUNS = [
  "pnpm boundaries",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm build",
  "pnpm verify:release",
];

function releaseWorkflow(runs = [...PREREQUISITE_RUNS, "pnpm tegami ci"]) {
  const steps = runs
    .map((run) => `      - name: step\n        run: ${run}`)
    .join("\n");
  return {
    path: RELEASE_WORKFLOW,
    source: `name: Release\non:\n  push:\n    branches: [main]\njobs:\n  release:\n    steps:\n${steps}\n`,
  };
}

function ciWorkflow(extraRuns = []) {
  const steps = ["pnpm test", ...extraRuns]
    .map((run) => `      - name: step\n        run: ${run}`)
    .join("\n");
  return {
    path: CI_WORKFLOW_PATH,
    source: `name: CI\non: [push, pull_request]\njobs:\n  checks:\n    steps:\n${steps}\n`,
  };
}

function securityWorkflow(path, triggers, extraJobYaml = "") {
  const list = triggers.map((trigger) => `"${trigger}"`).join(", ");
  return {
    path,
    source: `name: x\non: [${list}]\njobs:\n  scan:\n${extraJobYaml}    steps:\n      - name: scan\n        run: scan\n`,
  };
}

function baseSet() {
  return [
    ciWorkflow(),
    releaseWorkflow(),
    securityWorkflow(".github/workflows/codeql.yml", ["pull_request", "push"]),
    securityWorkflow(".github/workflows/gitleaks.yml", [
      "pull_request",
      "push",
    ]),
  ];
}

const DEFERRED_OK = [
  "## List",
  "",
  "### 1. Branch-protection enforcement",
  "",
  "Status: deferred. External-only; cannot be verified from repository files",
  "or local commands.",
  "",
  "## Other",
].join("\n");

describe("intra-workflow release gating (VAL-CROSS-005)", () => {
  it("shipped workflows satisfy the gating and visibility invariants", () => {
    const workflows = readWorkflows();
    expect(releaseSequencingProblems(workflows)).toEqual([]);
    const runbooks = readdirSync("docs/runbooks")
      .filter((file) => file.endsWith(".md"))
      .map((file) => ({
        path: `docs/runbooks/${file}`,
        source: readFileSync(join("docs/runbooks", file), "utf8"),
      }));
    expect(securityVisibilityProblems(workflows, runbooks)).toEqual([]);
    expect(
      deferredBranchProtectionProblems(readFileSync(DEFERRED_DOC, "utf8"))
    ).toEqual([]);
  });

  it("fails when the publish step precedes a correctness gate", () => {
    const runs = ["pnpm tegami ci", ...PREREQUISITE_RUNS];
    const problems = releaseSequencingProblems([releaseWorkflow(runs)]);
    expect(problems.some((p) => p.includes("publishes without"))).toBe(true);
  });

  it("fails when the publish job drops a prerequisite gate", () => {
    const runs = PREREQUISITE_RUNS.filter((run) => run !== "pnpm test");
    const problems = releaseSequencingProblems([
      releaseWorkflow([...runs, "pnpm tegami ci"]),
    ]);
    expect(
      problems.some((p) => p.includes("test") && p.includes("publishes"))
    ).toBe(true);
  });

  it("fails when release.yml has no publish step", () => {
    const problems = releaseSequencingProblems([
      releaseWorkflow(PREREQUISITE_RUNS),
    ]);
    expect(problems.some((p) => p.includes("no publish step"))).toBe(true);
  });

  it("fails on a cross-workflow dependency trigger", () => {
    const dependent = {
      path: ".github/workflows/publish-after.yml",
      source:
        "name: x\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\njobs:\n  job:\n    steps: []\n",
    };
    const problems = releaseSequencingProblems([releaseWorkflow(), dependent]);
    expect(problems.some((p) => p.includes("workflow_run"))).toBe(true);
  });

  it("fails when a workflow references branch protection", () => {
    const claimed = {
      path: ".github/workflows/ci.yml",
      source:
        "name: CI\n# branch protection keeps this gate required\non: [push]\njobs:\n  checks:\n    steps: []\n",
    };
    const problems = releaseSequencingProblems([releaseWorkflow(), claimed]);
    expect(problems.some((p) => p.includes("branch protection"))).toBe(true);
  });

  it("fails on a broken workflow reference (unparseable YAML)", () => {
    const broken = {
      path: ".github/workflows/broken.yml",
      source: "name: [unclosed\njobs: {",
    };
    const problems = releaseSequencingProblems([releaseWorkflow(), broken]);
    expect(problems.some((p) => p.includes("parse error"))).toBe(true);
  });
});

describe("security visibility without blocking claims (VAL-CROSS-007)", () => {
  it("fails when a security workflow loses its pull_request trigger", () => {
    const workflows = [
      ciWorkflow(),
      securityWorkflow(".github/workflows/codeql.yml", ["push"]),
      securityWorkflow(".github/workflows/gitleaks.yml", [
        "pull_request",
        "push",
      ]),
    ];
    const problems = securityVisibilityProblems(workflows);
    expect(
      problems.some(
        (p) => p.includes("codeql.yml") && p.includes("pull_request")
      )
    ).toBe(true);
  });

  it("fails when a security failure is muted with continue-on-error", () => {
    const workflows = [
      ciWorkflow(),
      securityWorkflow(
        ".github/workflows/codeql.yml",
        ["pull_request"],
        "    continue-on-error: true\n"
      ),
      securityWorkflow(".github/workflows/gitleaks.yml", ["pull_request"]),
    ];
    const problems = securityVisibilityProblems(workflows);
    expect(problems.some((p) => p.includes("continue-on-error"))).toBe(true);
  });

  it("fails when ci.yml publishes on the clean path", () => {
    const problems = securityVisibilityProblems([
      ciWorkflow(["pnpm tegami ci"]),
      securityWorkflow(".github/workflows/codeql.yml", ["pull_request"]),
      securityWorkflow(".github/workflows/gitleaks.yml", ["pull_request"]),
    ]);
    expect(problems.some((p) => p.includes("never publishes"))).toBe(true);
  });

  it("fails on a security blocking claim without deferral wording", () => {
    const docs = [
      {
        path: "docs/runbooks/x.md",
        source: "The gitleaks security scan blocks the release when it fails.",
      },
    ];
    const problems = securityVisibilityProblems(baseSet(), docs);
    expect(problems.some((p) => p.includes("blocking claim"))).toBe(true);
  });

  it("accepts visibility wording that names the external boundary", () => {
    const docs = [
      {
        path: "docs/runbooks/x.md",
        source:
          "A gitleaks security scan failure never blocks the release; branch protection is external.",
      },
    ];
    expect(securityVisibilityProblems(baseSet(), docs)).toEqual([]);
  });

  it("fails when the deferred list drops the branch-protection item", () => {
    const problems = deferredBranchProtectionProblems("## List\n\nNo items.\n");
    expect(problems.some((p) => p.includes("branch protection"))).toBe(true);
  });

  it("fails when the branch-protection item loses its deferred status", () => {
    const text = DEFERRED_OK.replace("Status: deferred.", "Status: active.");
    const problems = deferredBranchProtectionProblems(text);
    expect(problems.some((p) => p.includes("deferred status"))).toBe(true);
  });
});
