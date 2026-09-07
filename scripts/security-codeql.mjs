// CodeQL workflow invariants (VAL-SEC-027/028), imported by
// scripts/security-codeql.test.mjs. Everything here is static over committed
// files: workflow YAML parsing plus a runbook text scan. No network, no
// ports, no writes, no clock.

import { triggerSet } from "./flaky-ci.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const CODEQL_WORKFLOW_FILE = "codeql.yml";
export const CODEQL_WORKFLOW_PATH = `.github/workflows/${CODEQL_WORKFLOW_FILE}`;
export const SECURITY_RUNBOOK_PATH =
  "docs/runbooks/security-scan-failure-triage.md";

// Bounded trigger set for the CodeQL workflow (VAL-SEC-028).
const ALLOWED_TRIGGERS = new Set([
  "push",
  "pull_request",
  "schedule",
  "workflow_dispatch",
]);

// Language identifiers that CodeQL accepts for the JavaScript/TypeScript
// language (`javascript` and `typescript` are legacy aliases of the same
// extractor).
const JSTS_LANGUAGES = new Set([
  "javascript-typescript",
  "javascript",
  "typescript",
]);

const CODEQL_INIT = /^github\/codeql-action\/init@/;
const CODEQL_ANALYZE = /^github\/codeql-action\/analyze@/;

// Every {jobName, job, step} triple of a parsed workflow document.
function stepEntries(doc) {
  const entries = [];
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      entries.push({ jobName, job, step });
    }
  }
  return entries;
}

function usesMatches(entry, pattern) {
  return typeof entry.step?.uses === "string" && pattern.test(entry.step.uses);
}

function languageList(initStep) {
  return String(initStep?.with?.languages ?? "")
    .split(",")
    .map((language) => language.trim())
    .filter((language) => language !== "");
}

function triggerProblems(path, doc) {
  const triggers = triggerSet(doc?.on);
  const problems = [];
  if (triggers.length === 0) {
    problems.push(`${path} declares no triggers`);
    return problems;
  }
  for (const trigger of triggers) {
    if (!ALLOWED_TRIGGERS.has(trigger)) {
      problems.push(
        `${path} triggers on "${trigger}", outside the bounded set {push, pull_request, schedule, workflow_dispatch}`
      );
    }
  }
  // A push trigger must be bounded to the main branch, never every branch.
  const push = doc?.on?.push;
  if (triggers.includes("push")) {
    const branches = Array.isArray(push?.branches) ? push.branches : [];
    if (!branches.includes("main")) {
      problems.push(`${path} push trigger is not bounded to the main branch`);
    }
  }
  return problems;
}

// Effective permissions of the analyze job: a job-level block replaces the
// workflow-level block entirely (unspecified scopes become none).
function permissionProblems(path, doc, analyze) {
  const problems = [];
  const jobPerms = analyze.job?.permissions ?? doc?.permissions;
  if (jobPerms === null || typeof jobPerms !== "object") {
    problems.push(
      `${path} job "${analyze.jobName}" lacks an explicit minimal permissions block`
    );
    return problems;
  }
  if (jobPerms.contents !== "read") {
    problems.push(
      `${path} job "${analyze.jobName}" must declare permissions contents: read`
    );
  }
  if (jobPerms["security-events"] !== "write") {
    problems.push(
      `${path} job "${analyze.jobName}" must declare security-events: write so result upload is visible`
    );
  }
  for (const block of [doc?.permissions, analyze.job?.permissions]) {
    if (block === null || typeof block !== "object") {
      continue;
    }
    for (const [scope, value] of Object.entries(block)) {
      if (value === "write" && scope !== "security-events") {
        problems.push(
          `${path} grants "${scope}: write"; only security-events: write is allowed beyond contents: read`
        );
      }
    }
  }
  return problems;
}

// The analyze step uploads the SARIF results; an upload failure must fail the
// run visibly, never pass silently (VAL-SEC-028).
function visibleFailureProblems(path, analyze) {
  const label = `${path} job "${analyze.jobName}"`;
  const problems = [];
  if (analyze.step?.["continue-on-error"] === true) {
    problems.push(
      `${label} analyze step sets continue-on-error; an upload failure would pass silently`
    );
  }
  if (analyze.job?.["continue-on-error"] === true) {
    problems.push(
      `${label} sets job-level continue-on-error; an upload failure would pass silently`
    );
  }
  if (analyze.step?.with?.upload === "never") {
    problems.push(
      `${label} analyze step sets upload: never; results would never reach code scanning`
    );
  }
  return problems;
}

function workflowProblems(path, doc) {
  const entries = stepEntries(doc);
  const problems = [...triggerProblems(path, doc)];
  const init = entries.find((entry) => usesMatches(entry, CODEQL_INIT));
  if (!init) {
    problems.push(`${path} has no github/codeql-action/init step`);
  } else if (
    !languageList(init.step).some((language) => JSTS_LANGUAGES.has(language))
  ) {
    problems.push(
      `${path} init step does not declare the JavaScript/TypeScript language`
    );
  }
  const analyze = entries.find((entry) => usesMatches(entry, CODEQL_ANALYZE));
  if (!analyze) {
    problems.push(`${path} has no github/codeql-action/analyze step`);
    return problems;
  }
  problems.push(...permissionProblems(path, doc, analyze));
  problems.push(...visibleFailureProblems(path, analyze));
  return problems;
}

// Shipped-workflow invariants: at least one workflow runs CodeQL and every
// workflow that does satisfies the bounded, visible-failure shape.
export function codeqlProblems(workflows) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems).filter(({ doc }) =>
    stepEntries(doc).some(
      (entry) =>
        usesMatches(entry, CODEQL_INIT) || usesMatches(entry, CODEQL_ANALYZE)
    )
  );
  if (docs.length === 0) {
    problems.push("no workflow under .github/workflows runs codeql-action");
    return problems;
  }
  for (const { path, doc } of docs) {
    problems.push(...workflowProblems(path, doc));
  }
  return problems;
}

const CODEQL_WORD = /codeql/i;
const UPLOAD_FAILURE = /upload/i;
const FAILURE_WORD = /fail/i;
const RECOVERY_WORD = /recover|re-?run|retry/i;

// Runbook invariants: the security-scan runbook documents the CodeQL
// upload-failure mode and its recovery (VAL-SEC-028).
export function runbookCodeqlProblems(text) {
  const lines = text.split("\n");
  const problems = [];
  if (!lines.some((line) => CODEQL_WORD.test(line))) {
    problems.push("security-scan runbook never mentions the CodeQL workflow");
  }
  if (
    !lines.some((line) => UPLOAD_FAILURE.test(line) && FAILURE_WORD.test(line))
  ) {
    problems.push(
      "security-scan runbook does not document the CodeQL upload-failure mode"
    );
  }
  if (!lines.some((line) => RECOVERY_WORD.test(line))) {
    problems.push(
      "security-scan runbook does not document recovery from an upload failure"
    );
  }
  return problems;
}
