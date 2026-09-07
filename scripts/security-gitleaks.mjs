// gitleaks workflow/config invariants (VAL-SEC-029..032), imported by
// scripts/security-gitleaks.test.mjs. Everything here is static over
// committed files: workflow YAML parsing, a TOML-lite scan of the committed
// gitleaks config allowlist, and a runbook text scan. No network, no ports,
// no writes, no clock.

import { GITLEAKS_CONFIG_PATH } from "./security-gitleaks-config.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";
import { boundedTriggerProblems } from "./workflow-triggers.mjs";

export const GITLEAKS_WORKFLOW_FILE = "gitleaks.yml";
export const GITLEAKS_WORKFLOW_PATH = `.github/workflows/${GITLEAKS_WORKFLOW_FILE}`;

// The scan scope this repository declares: full git history. The binary is
// invoked as `gitleaks git` (history mode); a working-tree-only invocation
// (`gitleaks dir` / `--no-git`) is the OTHER scope and fails these checks
// unless the workflow and runbook deliberately switch scope together.
const GITLEAKS_HISTORY_RUN = /\bgitleaks\s+(git|detect)\b/;
const GITLEAKS_TREE_RUN = /\bgitleaks\s+dir\b|--no-git/;
const GITLEAKS_ACTION = /^gitleaks\/gitleaks-action@/;
const CHECKOUT_ACTION = "actions/checkout@";
const HISTORY_WORD = /history/i;

function stepEntries(doc) {
  const entries = [];
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      entries.push({ jobName, job, step });
    }
  }
  return entries;
}

function isGitleaksStep({ step }) {
  if (typeof step?.uses === "string") {
    return GITLEAKS_ACTION.test(step.uses);
  }
  return (
    typeof step?.run === "string" &&
    (GITLEAKS_HISTORY_RUN.test(step.run) || GITLEAKS_TREE_RUN.test(step.run))
  );
}

function triggerProblems(path, doc) {
  return boundedTriggerProblems(path, doc);
}

// Read-only permissions: no write scope anywhere, contents: read on the
// effective block (job-level replaces workflow-level entirely).
function permissionProblems(path, doc, scan) {
  const problems = [];
  const blocks = [doc?.permissions, scan.job?.permissions].filter(
    (block) => block !== null && typeof block === "object"
  );
  if (blocks.length === 0) {
    problems.push(`${path} lacks an explicit permissions block`);
    return problems;
  }
  const effective = scan.job?.permissions ?? doc?.permissions;
  if (effective.contents !== "read") {
    problems.push(
      `${path} job "${scan.jobName}" must declare permissions contents: read`
    );
  }
  for (const block of blocks) {
    for (const [scope, value] of Object.entries(block)) {
      if (value !== "read" && value !== "none") {
        problems.push(
          `${path} grants "${scope}: ${value}"; the gitleaks workflow must hold no write scope`
        );
      }
    }
  }
  return problems;
}

// Full-history scan scope (VAL-SEC-029): the checkout fetches every commit
// and the scan step runs the history mode against the committed config.
function scopeProblems(path, entries, scan) {
  const problems = [];
  const checkout = entries.find(
    ({ step }) =>
      typeof step?.uses === "string" && step.uses.startsWith(CHECKOUT_ACTION)
  );
  if (checkout?.step?.with?.["fetch-depth"] !== 0) {
    problems.push(
      `${path} lacks an actions/checkout step with fetch-depth: 0; full-history scope requires every commit`
    );
  }
  if (typeof scan.step?.run === "string") {
    if (GITLEAKS_TREE_RUN.test(scan.step.run)) {
      problems.push(
        `${path} scan step uses working-tree mode; the declared scope is full git history`
      );
    }
    if (!scan.step.run.includes(GITLEAKS_CONFIG_PATH)) {
      problems.push(
        `${path} scan step does not pass --config ${GITLEAKS_CONFIG_PATH}; the committed allowlist would not apply`
      );
    }
  }
  if (!HISTORY_WORD.test(String(scan.step?.name ?? ""))) {
    problems.push(
      `${path} scan step name must declare the history scope (contain "history")`
    );
  }
  return problems;
}

// Findings fail the run: no continue-on-error on the scan step or its job.
function visibleFailureProblems(path, scan) {
  const label = `${path} job "${scan.jobName}"`;
  const problems = [];
  if (scan.step?.["continue-on-error"] === true) {
    problems.push(
      `${label} scan step sets continue-on-error; findings would pass silently`
    );
  }
  if (scan.job?.["continue-on-error"] === true) {
    problems.push(
      `${label} sets job-level continue-on-error; findings would pass silently`
    );
  }
  return problems;
}

function workflowProblems(path, doc) {
  const entries = stepEntries(doc);
  const problems = [...triggerProblems(path, doc)];
  const scan = entries.find(isGitleaksStep);
  if (!scan) {
    problems.push(`${path} has no gitleaks scan step`);
    return problems;
  }
  problems.push(...permissionProblems(path, doc, scan));
  problems.push(...scopeProblems(path, entries, scan));
  problems.push(...visibleFailureProblems(path, scan));
  return problems;
}

export function gitleaksProblems(workflows) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems).filter(({ doc }) =>
    stepEntries(doc).some(isGitleaksStep)
  );
  if (docs.length === 0) {
    problems.push("no workflow under .github/workflows runs gitleaks");
    return problems;
  }
  for (const { path, doc } of docs) {
    problems.push(...workflowProblems(path, doc));
  }
  return problems;
}

// --- Runbook invariants (VAL-SEC-029/030/032) ------------------------------
// The committed-config allowlist invariants (VAL-SEC-031) live in
// security-gitleaks-config.mjs.

const RUNBOOK_RULES = [
  [/gitleaks/i, "never mentions the gitleaks workflow"],
  [/gitleaks\.yml/, "never cites the gitleaks.yml workflow file"],
  [
    /full[ -]?(git[ -]?)?history/i,
    "does not declare the full-history scan scope",
  ],
  [
    /push[\s\S]{0,200}pull[ _-]?request|pull[ _-]?request[\s\S]{0,200}push/i,
    "does not document the push/pull-request triggers",
  ],
  [/weekly|schedule|cron/i, "does not document the scheduled trigger"],
  [
    /exit|non-?zero|fails?\b/i,
    "does not document that findings fail the workflow",
  ],
  [/rotate/i, "does not document rotating a true-positive secret"],
  [
    /\.gitleaks\.toml/,
    "does not document the .gitleaks.toml allowlist triage path",
  ],
  [
    /not installed|unavailable|absent|no local/i,
    "does not document the unavailable-local-binary behavior",
  ],
];

export function runbookGitleaksProblems(text) {
  return RUNBOOK_RULES.filter(([pattern]) => !pattern.test(text)).map(
    ([, message]) => `security-scan runbook ${message}`
  );
}
