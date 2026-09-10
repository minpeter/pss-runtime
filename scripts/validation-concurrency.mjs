// Concurrency-budget and cleanup-contract documentation invariants
// (VAL-CROSS-013), imported by scripts/validation-concurrency.test.mjs.
// CONTRIBUTING.md declares the cross-area validation concurrency limits and
// the validator cleanup contract; this module pins both, plus the existence
// of the timeout wrapper and the observe-only post-run cleanup check, and
// the gitignored evidence root. Static over committed files plus
// `git check-ignore`: no network, no ports, no writes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitIgnoredPaths } from "./governance-contributing.mjs";

export const CONTRIBUTING_PATH = "CONTRIBUTING.md";
export const TIME_GATE_PATH = "scripts/time-gate.mjs";
export const CLEANUP_CHECK_PATH = "scripts/check-validation-cleanup.mjs";
export const EVIDENCE_ROOT = ".omo/evidence/";
// Probed evidence path used to prove the evidence tree stays gitignored.
export const EVIDENCE_PROBE = `${EVIDENCE_ROOT}validation-cleanup/cleanup-check.json`;

export function readContributing(root = ".") {
  return readFileSync(join(root, CONTRIBUTING_PATH), "utf8");
}

// The declared cross-area concurrency budget: each class carries an explicit
// numeric limit so a quiet edit that relaxes one fails by name.
const BUDGET_MARKERS = [
  [/two\s+Worker\/HTTP\s+validators/i, "two Worker/HTTP validators"],
  [/one\s+TUI\s+validator/i, "one TUI validator"],
  [
    /two\s+lightweight\s+static\/config\s+validators/i,
    "two lightweight static/config validators",
  ],
  [/one\s+devcontainer\s+build/i, "one devcontainer build"],
  [/serial\s+two-checkout/i, "serial two-checkout runs"],
];

export function budgetProblems(text) {
  return BUDGET_MARKERS.filter(([pattern]) => !pattern.test(text)).map(
    ([, label]) =>
      `${CONTRIBUTING_PATH} no longer declares the ${label} concurrency limit`
  );
}

// The validator cleanup contract: kill only PIDs recorded at startup, track
// listeners before/after, bound every command with the time-gate wrapper,
// finish with the observe-only post-run check, and keep evidence gitignored.
const CLEANUP_MARKERS = [
  [/only the PIDs it recorded at startup/, "the recorded-PID-only kill rule"],
  [/ss -tlnp/, "the ss -tlnp before/after listener inventory"],
  [/scripts\/time-gate\.mjs/, "the time-gate timeout guard"],
  [
    /check-validation-cleanup\.mjs check --baseline/,
    "the check-validation-cleanup post-run check",
  ],
  [/never terminates anything/, "the never-terminates observe-only guarantee"],
  [/\.omo\/evidence\//, "the gitignored evidence root"],
];

export function cleanupDocProblems(text) {
  return CLEANUP_MARKERS.filter(([pattern]) => !pattern.test(text)).map(
    ([, label]) => `${CONTRIBUTING_PATH} no longer documents ${label}`
  );
}

// Validation evidence lands under the gitignored evidence tree and is never
// committed.
export function evidenceIgnoreProblems(root = ".") {
  return gitIgnoredPaths([EVIDENCE_PROBE], root).has(EVIDENCE_PROBE)
    ? []
    : [`${EVIDENCE_ROOT} evidence is not gitignored`];
}

export function validationConcurrencyProblems(root = ".") {
  const problems = [];
  let text = null;
  try {
    text = readContributing(root);
  } catch {
    problems.push(`${CONTRIBUTING_PATH} is missing`);
  }
  if (text !== null) {
    problems.push(...budgetProblems(text));
    problems.push(...cleanupDocProblems(text));
  }
  for (const path of [TIME_GATE_PATH, CLEANUP_CHECK_PATH]) {
    if (!existsSync(join(root, path))) {
      problems.push(`${path} is missing; the cleanup contract references it`);
    }
  }
  problems.push(...evidenceIgnoreProblems(root));
  return problems;
}
