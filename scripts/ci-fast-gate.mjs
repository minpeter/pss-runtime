// Fast-gate CI structure invariants (VAL-SEC-046), imported by
// scripts/ci-fast-gate.test.mjs. Everything here is static over committed
// workflow files: no network, no ports, no writes.
//
// Two halves:
//   fastGateProblems       the fast PR gate (ci.yml) invokes every
//                          deterministic check root script (workspace drift,
//                          bundle budget, Knip, jscpd, the scripts invariant
//                          suite carrying the documentation invariants, test
//                          timing) and keeps the pre-existing core steps in
//                          their relative order.
//   costSeparationProblems expensive checks (CodeQL, gitleaks, ZAP, flaky
//                          detection, storage stress) never appear inside
//                          ci.yml and each lives in exactly one distinct
//                          workflow file that declares its own triggers.

import { triggerSet } from "./flaky-ci.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

// Deterministic checks the fast gate must invoke. `pattern` matches a single
// step's run text; gate-mode wrappers require their explicit --check flag so
// a bare usage-printing invocation never satisfies the invariant.
const REQUIRED_FAST_CHECKS = [
  {
    label: "workspace drift gate (check:workspace-drift --check)",
    pattern: /(^|\s)check:workspace-drift\b[^\n]*--check(\s|$)/,
  },
  {
    label: "bundle budget gate (check:bundle-size --check)",
    pattern: /(^|\s)check:bundle-size\b[^\n]*--check(\s|$)/,
  },
  {
    label: "Knip unused-code gate (check:unused)",
    pattern: /(^|\s)check:unused(\s|$|\|)/,
  },
  {
    label: "jscpd duplicate-code gate (check:duplicates)",
    pattern: /(^|\s)check:duplicates(\s|$|\|)/,
  },
  {
    // The root `pnpm test` collects scripts/*.test.mjs, which carries the
    // documentation invariants (runtime-docs, governance-readme, ...).
    label: "documentation invariants via the root test suite (pnpm test)",
    pattern: /(^|\s)pnpm\s+test(\s|$)/,
  },
  {
    label: "test-timing producer (test:timing)",
    pattern: /(^|\s)test:timing(\s|$)/,
  },
];

// Pre-existing core gate steps whose relative order is pinned: the fast gate
// stays the source of truth for core correctness.
const CORE_STEP_ORDER = [
  { label: "lint", pattern: /(^|\s)pnpm\s+lint(\s|$)/ },
  { label: "typecheck", pattern: /(^|\s)pnpm\s+typecheck(\s|$)/ },
  { label: "test", pattern: /(^|\s)pnpm\s+test(\s|$)/ },
  { label: "build", pattern: /(^|\s)pnpm\s+build(\s|$)/ },
  { label: "api:check", pattern: /(^|\s)pnpm\s+api:check(\s|$)/ },
  {
    label: "verify:release",
    pattern: /(^|\s)pnpm\s+verify:release(\s|$)/,
  },
];

const BUILD_STEP = /(^|\s)pnpm\s+build(\s|$)/;
const BUNDLE_STEP = /(^|\s)check:bundle-size\b/;

// Expensive or scheduled checks that must never run inline in ci.yml. Each
// pattern matches the step fields (name/run/uses) of the check's home
// workflow; ci.yml is scanned for the same signatures.
const EXPENSIVE_CHECKS = [
  { label: "CodeQL", pattern: /codeql/i },
  { label: "gitleaks", pattern: /gitleaks/i },
  { label: "OWASP ZAP", pattern: /\bzap\b/i },
  { label: "flaky detection", pattern: /(^|\s)test:flaky(\s|$)/ },
  {
    label: "storage stress",
    pattern: /(^|\s)stress:runtime-storage\b/,
  },
];

function stepTexts(doc) {
  const texts = [];
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      texts.push(
        [step?.name, step?.run, step?.uses]
          .filter((value) => typeof value === "string")
          .join("\n")
      );
    }
  }
  return texts;
}

function ciSteps(workflows, problems) {
  for (const { path, doc } of parseWorkflowDocs(workflows, problems)) {
    if (path === CI_WORKFLOW_PATH) {
      return stepTexts(doc);
    }
  }
  problems.push(`${CI_WORKFLOW_PATH} is missing from the workflow set`);
  return [];
}

function firstIndex(steps, pattern) {
  return steps.findIndex((text) => pattern.test(text));
}

function orderProblems(steps) {
  const problems = [];
  let previous = -1;
  let previousLabel = null;
  for (const { label, pattern } of CORE_STEP_ORDER) {
    const index = firstIndex(steps, pattern);
    if (index === -1) {
      problems.push(`ci.yml no longer runs the core "${label}" step`);
      continue;
    }
    if (index < previous) {
      problems.push(
        `ci.yml runs "${label}" before "${previousLabel}"; the pre-existing core step order is pinned`
      );
    }
    previous = Math.max(previous, index);
    previousLabel = label;
  }
  return problems;
}

export function fastGateProblems(workflows) {
  const problems = [];
  const steps = ciSteps(workflows, problems);
  for (const { label, pattern } of REQUIRED_FAST_CHECKS) {
    if (!steps.some((text) => pattern.test(text))) {
      problems.push(`ci.yml does not invoke the ${label}`);
    }
  }
  problems.push(...orderProblems(steps));
  const buildIndex = firstIndex(steps, BUILD_STEP);
  const bundleIndex = firstIndex(steps, BUNDLE_STEP);
  if (bundleIndex !== -1 && buildIndex !== -1 && bundleIndex < buildIndex) {
    problems.push(
      'ci.yml runs the bundle budget gate before "pnpm build"; the gate fails on a missing dist/'
    );
  }
  return problems;
}

export function costSeparationProblems(workflows) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems);
  for (const { label, pattern } of EXPENSIVE_CHECKS) {
    const carriers = docs.filter(({ doc }) =>
      stepTexts(doc).some((text) => pattern.test(text))
    );
    if (carriers.some(({ path }) => path === CI_WORKFLOW_PATH)) {
      problems.push(
        `ci.yml carries a ${label} step; expensive checks never run inline in the fast PR gate`
      );
    }
    const external = carriers.filter(({ path }) => path !== CI_WORKFLOW_PATH);
    if (external.length === 0) {
      problems.push(`no workflow outside ci.yml runs the ${label} check`);
      continue;
    }
    if (external.length > 1) {
      problems.push(
        `the ${label} check runs in ${external.length} workflow files (${external
          .map(({ path }) => path)
          .join(", ")}); it must live in exactly one distinct workflow file`
      );
    }
    for (const { path, doc } of external) {
      if (triggerSet(doc?.on).length === 0) {
        problems.push(
          `${path} runs the ${label} check but declares no triggers of its own`
        );
      }
    }
  }
  return problems;
}
