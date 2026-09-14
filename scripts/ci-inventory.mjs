// CI fast-gate inventory invariants (VAL-CROSS-004/006), imported by
// scripts/ci-inventory.test.mjs. Everything here is static over committed
// workflow files: no network, no ports, no writes.
//
// Three halves:
//   fastGateStepOrderProblems  the ci.yml job `checks` keeps the twelve
//                              documented fast-gate steps (mirrored by
//                              docs/runbooks/ci-failure-triage.md) exactly
//                              once each and in their pinned relative order;
//                              additive analysis steps may sit between them
//                              but never reorder or replace them.
//   workflowClassProblems      every workflow file is classified
//                              deterministic (pull_request/push), scheduled,
//                              or manual, and the scheduled/manual analysis
//                              workflows carry bounded job timeouts.
//   driftAlongsideProblems     the workspace drift gate accompanies the
//                              package-boundary and release verification
//                              gates in ci.yml — it is never a substitute.

import { triggerSet } from "./flaky-ci.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const CI_INVENTORY_WORKFLOW = ".github/workflows/ci.yml";
const KNOWN_BOUNDED_REUSABLE_WORKFLOWS = new Set([CI_INVENTORY_WORKFLOW]);
const LOCAL_PREFIX = /^\.\//;

// The twelve documented fast-gate steps of the ci.yml job `checks`, pinned
// in relative order (VAL-CROSS-004).
export const FAST_GATE_STEPS = [
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
];

// Documented workflow classification (VAL-CROSS-004): `require`d triggers
// must be present, `forbid`den triggers must stay absent, and `bounded`
// workflows give every job a numeric timeout-minutes.
export const WORKFLOW_CLASSES = [
  {
    path: CI_INVENTORY_WORKFLOW,
    require: ["pull_request", "push", "workflow_call", "workflow_dispatch"],
    forbid: ["schedule"],
    bounded: true,
  },
  {
    path: ".github/workflows/release.yml",
    require: ["push"],
    forbid: ["pull_request", "schedule", "workflow_dispatch"],
    bounded: true,
  },
  {
    path: ".github/workflows/codeql.yml",
    require: ["pull_request", "push", "schedule", "workflow_dispatch"],
    forbid: [],
    bounded: true,
  },
  {
    path: ".github/workflows/gitleaks.yml",
    require: ["pull_request", "push", "schedule", "workflow_dispatch"],
    forbid: [],
    bounded: true,
  },
  {
    path: ".github/workflows/flaky-tests.yml",
    require: ["schedule", "workflow_dispatch"],
    forbid: ["pull_request", "push"],
    bounded: true,
  },
  {
    path: ".github/workflows/extended-verification.yml",
    require: ["schedule", "workflow_dispatch"],
    forbid: ["pull_request", "push"],
    bounded: true,
  },
  {
    path: ".github/workflows/zap.yml",
    require: ["workflow_dispatch"],
    forbid: ["pull_request", "push", "schedule"],
    bounded: true,
  },
];

function ciChecksSteps(workflows, problems) {
  for (const { path, doc } of parseWorkflowDocs(workflows, problems)) {
    if (path === CI_INVENTORY_WORKFLOW) {
      return doc?.jobs?.checks?.steps ?? [];
    }
  }
  problems.push(`${CI_INVENTORY_WORKFLOW} is missing from the workflow set`);
  return [];
}

export function fastGateStepOrderProblems(workflows) {
  const problems = [];
  const names = ciChecksSteps(workflows, problems).map((step) =>
    String(step?.name ?? "")
  );
  let previous = -1;
  let previousStep = null;
  for (const step of FAST_GATE_STEPS) {
    const indices = names.flatMap((name, index) =>
      name === step ? [index] : []
    );
    if (indices.length === 0) {
      problems.push(
        `ci.yml job "checks" no longer has the documented fast-gate step "${step}"`
      );
      continue;
    }
    if (indices.length > 1) {
      problems.push(
        `ci.yml job "checks" repeats the documented fast-gate step "${step}"`
      );
    }
    if (indices[0] < previous) {
      problems.push(
        `ci.yml job "checks" runs "${step}" before "${previousStep}"; the documented relative order is pinned`
      );
    }
    previous = Math.max(previous, indices[0]);
    previousStep = step;
  }
  return problems;
}

function classTriggerProblems(entry, triggers) {
  const problems = [];
  for (const required of entry.require) {
    if (!triggers.includes(required)) {
      problems.push(
        `${entry.path} lost its required ${required} trigger; its documented classification changed`
      );
    }
  }
  for (const forbidden of entry.forbid) {
    if (triggers.includes(forbidden)) {
      problems.push(
        `${entry.path} gained a ${forbidden} trigger outside its documented classification`
      );
    }
  }
  return problems;
}

function boundedJobProblems(entry, jobId, job, docsByPath) {
  if (typeof job?.uses !== "string") {
    return typeof job?.["timeout-minutes"] === "number"
      ? []
      : [`${entry.path} job "${jobId}" lacks a bounded timeout-minutes`];
  }
  const calledPath = String(job.uses).replace(LOCAL_PREFIX, "");
  if (!KNOWN_BOUNDED_REUSABLE_WORKFLOWS.has(calledPath)) {
    return [
      `${entry.path} job "${jobId}" calls ${job.uses}; only known local reusable workflows have inspectable timeout evidence`,
    ];
  }
  const calledJobs = Object.values(docsByPath.get(calledPath)?.jobs ?? {});
  if (
    calledJobs.length === 0 ||
    calledJobs.some(
      (calledJob) => typeof calledJob?.["timeout-minutes"] !== "number"
    )
  ) {
    return [
      `${entry.path} job "${jobId}" calls ${job.uses} without complete bounded timeout evidence`,
    ];
  }
  return [];
}

export function workflowClassProblems(workflows) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems);
  const docsByPath = new Map(docs.map(({ path, doc }) => [path, doc]));
  const known = new Set(WORKFLOW_CLASSES.map((entry) => entry.path));
  for (const { path } of docs) {
    if (!known.has(path)) {
      problems.push(
        `${path} is an unclassified workflow; classify it deterministic/scheduled/manual/bounded in scripts/ci-inventory.mjs`
      );
    }
  }
  for (const entry of WORKFLOW_CLASSES) {
    const doc = docs.find(({ path }) => path === entry.path)?.doc;
    if (!doc) {
      problems.push(`${entry.path} is missing from the workflow set`);
      continue;
    }
    problems.push(...classTriggerProblems(entry, triggerSet(doc?.on)));
    if (entry.bounded) {
      for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
        problems.push(...boundedJobProblems(entry, jobId, job, docsByPath));
      }
    }
  }
  return problems;
}

const DRIFT_GATE = /(^|\s)check:workspace-drift\b[^\n]*--check/;
const BOUNDARY_GATE = /(^|\s)pnpm\s+boundaries(\s|$)/;
const RELEASE_VERIFY = /(^|\s)pnpm\s+verify:release(\s|$)/;

// VAL-CROSS-006: a clean drift result is required ALONGSIDE the
// package-boundary and release verification gates, never as a substitute.
export function driftAlongsideProblems(workflows) {
  const problems = [];
  const runs = ciChecksSteps(workflows, problems)
    .map((step) => step?.run)
    .filter((run) => typeof run === "string");
  const gates = [
    { label: "workspace drift gate", pattern: DRIFT_GATE },
    {
      label: "package-boundary gate (pnpm boundaries)",
      pattern: BOUNDARY_GATE,
    },
    {
      label: "release verification (pnpm verify:release)",
      pattern: RELEASE_VERIFY,
    },
  ];
  for (const { label, pattern } of gates) {
    if (!runs.some((run) => pattern.test(run))) {
      problems.push(
        `ci.yml job "checks" no longer runs the ${label}; the drift result must accompany the package-boundary and release gates, never substitute for them`
      );
    }
  }
  return problems;
}
