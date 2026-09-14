// Intra-workflow release gating and security-visibility invariants
// (VAL-CROSS-005/007), imported by scripts/ci-release-gating.test.mjs.
// Everything here is static over committed files: no network, no ports, no
// writes.
//
//   releaseSequencingProblems        release.yml calls the complete ci.yml
//                                    gate at the same SHA, then a separate,
//                                    least-privilege publish job needs that
//                                    validation; release runs are serialized.
//   securityVisibilityProblems       CodeQL/gitleaks failures stay visible
//                                    (pull_request trigger, no
//                                    continue-on-error), no document claims
//                                    a security failure blocks release, and
//                                    the clean ci.yml path never publishes.
//   deferredBranchProtectionProblems the deferred list keeps naming branch
//                                    protection with a deferred status.

import { CI_WORKFLOW_PATH } from "./ci-fast-gate.mjs";
import {
  containsPublishCommand,
  publishJobProblems,
  publishStepLocations,
} from "./ci-publish-policy.mjs";
import { triggerSet } from "./flaky-ci.mjs";
import { itemSections } from "./governance-deferred.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

const SECURITY_WORKFLOW_FILES = [
  ".github/workflows/codeql.yml",
  ".github/workflows/gitleaks.yml",
];

const PUBLISH_STEP = /(^|\s)pnpm\s+tegami\s+ci(\s|$)/;
const BRANCH_PROTECTION = /branch[- ]protection/i;
const DEFERRED_STATUS = /status:\s*deferred/i;

const VALIDATION_WORKFLOW = "./.github/workflows/ci.yml";
const githubExpression = (name) => `\${{ ${name} }}`;
const ISOLATED_CI_GROUP = `ci-${githubExpression("github.workflow")}-${githubExpression("github.ref")}`;
const RELEASE_GROUP = `${githubExpression("github.workflow")}-${githubExpression("github.ref")}`;

function permissionIsolationProblems(jobs, validationIds) {
  const problems = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    if (validationIds.includes(jobId)) {
      if (job?.permissions?.contents !== "read") {
        problems.push(
          `${RELEASE_WORKFLOW} validation job must use contents: read`
        );
      }
      if (Object.values(job?.permissions ?? {}).includes("write")) {
        problems.push(
          `${RELEASE_WORKFLOW} validation job must not have write permission`
        );
      }
    } else if (
      Object.values(job?.permissions ?? {}).includes("write") &&
      !job?.steps?.some((step) => PUBLISH_STEP.test(String(step?.run ?? "")))
    ) {
      problems.push(
        `${RELEASE_WORKFLOW} non-publish job "${jobId}" has write permission`
      );
    }
  }
  return problems;
}

function publishSequencingProblems(docs, problems) {
  const release = docs.find(({ path }) => path === RELEASE_WORKFLOW);
  if (!release) {
    problems.push(`${RELEASE_WORKFLOW} is missing from the workflow set`);
    return;
  }
  const jobs = release.doc?.jobs ?? {};
  const validationIds = Object.entries(jobs)
    .filter(([, job]) => job?.uses === VALIDATION_WORKFLOW)
    .map(([jobId]) => jobId);
  if (validationIds.length !== 1) {
    problems.push(
      `${RELEASE_WORKFLOW} must call ${VALIDATION_WORKFLOW} exactly once`
    );
  }
  const publishLocations = publishStepLocations(
    jobs,
    RELEASE_WORKFLOW,
    problems
  );
  for (const { jobId, job, publishIndex } of publishLocations) {
    problems.push(
      ...publishJobProblems({
        jobId,
        job,
        validationIds,
        publishIndex,
        workflowPath: RELEASE_WORKFLOW,
      })
    );
  }
  if (publishLocations.length === 0) {
    problems.push(
      `${RELEASE_WORKFLOW} has no publish step; expected exactly one (pnpm tegami ci)`
    );
  } else if (publishLocations.length > 1) {
    problems.push(
      `${RELEASE_WORKFLOW} must have exactly one publish step (pnpm tegami ci)`
    );
  } else {
    const [{ jobId, publishIndex }] = publishLocations;
    if (publishIndex !== (jobs[jobId]?.steps?.length ?? 0) - 1) {
      problems.push(`${RELEASE_WORKFLOW} publish step must be the final step`);
    }
  }
  problems.push(...permissionIsolationProblems(jobs, validationIds));
  if (release.doc?.concurrency?.["cancel-in-progress"] !== false) {
    problems.push(
      `${RELEASE_WORKFLOW} must not cancel an in-flight release run`
    );
  }
  if (release.doc?.concurrency?.group !== RELEASE_GROUP) {
    problems.push(
      `${RELEASE_WORKFLOW} must serialize release runs in one stable group per ref`
    );
  }
}

function reusableConcurrencyProblems(docs, problems) {
  const ci = docs.find(({ path }) => path === CI_WORKFLOW_PATH);
  if (!ci) {
    return;
  }
  if (ci.doc?.concurrency?.group !== ISOLATED_CI_GROUP) {
    problems.push(
      `${CI_WORKFLOW_PATH} concurrency must include github.workflow so standalone CI cannot cancel release validation on the same ref`
    );
  }
  if (ci.doc?.concurrency?.["cancel-in-progress"] !== true) {
    problems.push(
      `${CI_WORKFLOW_PATH} must cancel stale runs within each isolated caller group`
    );
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
  reusableConcurrencyProblems(docs, problems);
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
      if (typeof step?.run === "string" && containsPublishCommand(step.run)) {
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
