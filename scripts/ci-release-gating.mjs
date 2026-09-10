// Intra-workflow release gating and security-visibility invariants
// (VAL-CROSS-005/007), imported by scripts/ci-release-gating.test.mjs.
// Everything here is static over committed files: no network, no ports, no
// writes.
//
//   releaseSequencingProblems        release.yml publishes only after the
//                                    correctness gates INSIDE the same job
//                                    (sequential steps fail the job, so a
//                                    later publish step cannot report pass
//                                    while an earlier gate fails); no
//                                    cross-workflow dependency
//                                    (workflow_run) and no branch-protection
//                                    mechanism is used or claimed.
//   securityVisibilityProblems       CodeQL/gitleaks failures stay visible
//                                    (pull_request trigger, no
//                                    continue-on-error), no document claims
//                                    a security failure blocks release, and
//                                    the clean ci.yml path never publishes.
//   deferredBranchProtectionProblems the deferred list keeps naming branch
//                                    protection with a deferred status.

import { CI_WORKFLOW_PATH } from "./ci-fast-gate.mjs";
import { triggerSet } from "./flaky-ci.mjs";
import { itemSections } from "./governance-deferred.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

const SECURITY_WORKFLOW_FILES = [
  ".github/workflows/codeql.yml",
  ".github/workflows/gitleaks.yml",
];

const PUBLISH_STEP = /(^|\s)pnpm\s+tegami\s+ci(\s|$)/;
const PUBLISH_ANYWHERE = /\btegami\s+ci\b|\bnpm\s+publish\b|\bpnpm\s+publish\b/;
const BRANCH_PROTECTION = /branch[- ]protection/i;
const DEFERRED_STATUS = /status:\s*deferred/i;

// Gates that must precede the publish step inside the same release job.
const PREREQUISITES = [
  { label: "package boundaries", pattern: /(^|\s)pnpm\s+boundaries(\s|$)/ },
  { label: "lint", pattern: /(^|\s)pnpm\s+lint(\s|$)/ },
  { label: "typecheck", pattern: /(^|\s)pnpm\s+typecheck(\s|$)/ },
  { label: "test", pattern: /(^|\s)pnpm\s+test(\s|$)/ },
  { label: "build", pattern: /(^|\s)pnpm\s+build(\s|$)/ },
  {
    label: "release verification",
    pattern: /(^|\s)pnpm\s+verify:release(\s|$)/,
  },
];

function publishSequencingProblems(docs, problems) {
  const release = docs.find(({ path }) => path === RELEASE_WORKFLOW);
  if (!release) {
    problems.push(`${RELEASE_WORKFLOW} is missing from the workflow set`);
    return;
  }
  let publishSeen = false;
  for (const [jobId, job] of Object.entries(release.doc?.jobs ?? {})) {
    const steps = job?.steps ?? [];
    const publishIndex = steps.findIndex(
      (step) => typeof step?.run === "string" && PUBLISH_STEP.test(step.run)
    );
    if (publishIndex === -1) {
      continue;
    }
    publishSeen = true;
    const earlier = steps
      .slice(0, publishIndex)
      .map((step) => String(step?.run ?? ""));
    for (const { label, pattern } of PREREQUISITES) {
      if (!earlier.some((run) => pattern.test(run))) {
        problems.push(
          `${RELEASE_WORKFLOW} job "${jobId}" publishes without an earlier ${label} step; a failing gate in the same job must stop the publish step`
        );
      }
    }
  }
  if (!publishSeen) {
    problems.push(`${RELEASE_WORKFLOW} has no publish step (pnpm tegami ci)`);
  }
}

export function releaseSequencingProblems(workflows) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems);
  for (const { path, source } of workflows) {
    if (BRANCH_PROTECTION.test(String(source))) {
      problems.push(
        `${path} references branch protection; enforcement is an external deferred control, never a repository mechanism`
      );
    }
  }
  for (const { path, doc } of docs) {
    if (triggerSet(doc?.on).includes("workflow_run")) {
      problems.push(
        `${path} declares a workflow_run trigger; release gating is intra-workflow only, never a cross-workflow dependency`
      );
    }
  }
  publishSequencingProblems(docs, problems);
  return problems;
}

const SECURITY_TERM = /codeql|gitleaks|\bzap\b|security scan/i;
const BLOCKING_CLAIM =
  /\bblocks?\b|\bmust (?:pass|be green) before\b|\brequired (?:status )?check|\bgates? the release/i;
const VISIBILITY_WORD =
  /\bnever\b|\bnot\b|\bno\b|\bdeferred\b|\bexternal\b|\badvisory\b|\bcannot\b|\babsence\b/i;

function visibilityProblems(docs, problems) {
  for (const file of SECURITY_WORKFLOW_FILES) {
    const entry = docs.find(({ path }) => path === file);
    if (!entry) {
      problems.push(
        `${file} is missing; security scan failures must stay visible in CI`
      );
      continue;
    }
    if (!triggerSet(entry.doc?.on).includes("pull_request")) {
      problems.push(
        `${file} no longer runs on pull_request; a scan failure must stay visible as a failed check`
      );
    }
    for (const [jobId, job] of Object.entries(entry.doc?.jobs ?? {})) {
      if (job?.["continue-on-error"] === true) {
        problems.push(
          `${file} job "${jobId}" sets continue-on-error; a muted security failure is never visible`
        );
      }
      for (const step of job?.steps ?? []) {
        if (step?.["continue-on-error"] === true) {
          problems.push(
            `${file} job "${jobId}" step "${step?.name ?? "?"}" sets continue-on-error; a muted security failure is never visible`
          );
        }
      }
    }
  }
}

function blockingClaimProblems(workflows, extraTexts, problems) {
  for (const { path, source } of [...workflows, ...extraTexts]) {
    for (const line of String(source).split("\n")) {
      if (
        SECURITY_TERM.test(line) &&
        BLOCKING_CLAIM.test(line) &&
        !VISIBILITY_WORD.test(line)
      ) {
        problems.push(
          `${path}: security blocking claim without deferral wording: ${line.trim().slice(0, 120)}`
        );
      }
    }
  }
}

function cleanPathProblems(docs, problems) {
  const ci = docs.find(({ path }) => path === CI_WORKFLOW_PATH);
  if (!ci) {
    return;
  }
  for (const job of Object.values(ci.doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === "string" && PUBLISH_ANYWHERE.test(step.run)) {
        problems.push(
          `${CI_WORKFLOW_PATH} runs a publish step ("${step?.name ?? "?"}"); the clean fast-gate path never publishes`
        );
      }
    }
  }
}

export function securityVisibilityProblems(workflows, extraTexts = []) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems);
  visibilityProblems(docs, problems);
  blockingClaimProblems(workflows, extraTexts, problems);
  cleanPathProblems(docs, problems);
  return problems;
}

// The deferred list keeps naming branch protection with a deferred status
// (VAL-CROSS-007); governance-deferred.test.mjs owns the full inventory.
export function deferredBranchProtectionProblems(text) {
  const section = itemSections(text).find((s) =>
    BRANCH_PROTECTION.test(s.title)
  );
  if (!section) {
    return [
      "the deferred list no longer names branch protection as a deferred item",
    ];
  }
  if (!DEFERRED_STATUS.test(section.body)) {
    return ["the branch-protection deferred item lost its deferred status"];
  }
  return [];
}
