import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { README_FILE, readDoc, WORKFLOWS_DIR } from "./governance-deferred.mjs";
import { DEFERRED_DOC } from "./governance-readme.mjs";

// Repo-wide deferred-claim scan surfaces (VAL-GOV-056).
export const CLAIM_SCAN_FILES = [
  README_FILE,
  "AGENTS.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/label-taxonomy.md",
  DEFERRED_DOC,
];
export const CLAIM_SCAN_DIRS = ["docs/runbooks", WORKFLOWS_DIR];

// Deferred-item names for the repo-wide claim scan (VAL-GOV-056).
const ITEM_TERM =
  /branch protection|secret[- ]scanning|secret scan|analytics|sentry|bugsnag|rollbar|error tracking|alerting|pagerduty|opsgenie|progressive rollout|rollback|label creation|codeowners enforcement|dependabot|health monitoring|production deployment|gitleaks|codeql/i;
const COMPLETION =
  /\b(?:is|are|was|were|has been|have been)\s+(?:now\s+|fully\s+)?(?:enabled|configured|activated|active|deployed|rolled out|verified|enforced|live|complete|completed|done)\b/i;
const DEFERRAL =
  /\b(?:deferred|external|out[- ]of[- ]scope|not configured|cannot|planned|pending|advisory|never|no hosted|do not|don't|must not|would)\b/i;

// Workflow secret-reference rule (VAL-GOV-057).
const SECRET_REF = /\$\{\{\s*secrets\.([A-Z0-9_]+)(?:\s*\|\|[^}]*)?\s*\}\}/g;
const EXEMPT_SECRETS = new Set(["GITHUB_TOKEN"]);
const GATE_ID = /(?:^|[-_])secret-gate$/;
const GATE_OUTPUT = /needs\.secret-gate\.outputs/;
const STEP_SUMMARY = /GITHUB_STEP_SUMMARY/;
const SKIP_WORD = /skip/i;
const SCAN_ENTRY = /\.(md|ya?ml)$/;
const YAML_FILE = /\.ya?ml$/;

// Lines claiming a deferred control is complete, without deferral wording
// (VAL-GOV-056).
export function deferredClaimHits(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        ITEM_TERM.test(line) && COMPLETION.test(line) && !DEFERRAL.test(line)
    );
}

export function claimScanPaths(root = ".") {
  const paths = [...CLAIM_SCAN_FILES];
  for (const dir of CLAIM_SCAN_DIRS) {
    const full = join(root, dir);
    if (!existsSync(full)) {
      continue;
    }
    for (const entry of readdirSync(full).sort()) {
      if (SCAN_ENTRY.test(entry)) {
        paths.push(`${dir}/${entry}`);
      }
    }
  }
  return paths;
}

export function repoWideClaimHits(root = ".") {
  return claimScanPaths(root).flatMap((path) =>
    deferredClaimHits(readDoc(path, root)).map((line) => `${path}: ${line}`)
  );
}

// Default-path workflow secret problems (VAL-GOV-057): any non-exempt secret
// reference must live in the secret-gate job or in a job gated on its outputs,
// and the gate must emit a visible skip instead of passing silently.
export function workflowSecretIssues(name, text) {
  const jobs = parse(text)?.jobs ?? {};
  const issues = [];
  let anySecret = false;
  let gateHasVisibleSkip = false;
  for (const [id, job] of Object.entries(jobs)) {
    const blob = JSON.stringify(job) ?? "";
    if (GATE_ID.test(id) && STEP_SUMMARY.test(blob) && SKIP_WORD.test(blob)) {
      gateHasVisibleSkip = true;
    }
    const refs = [...blob.matchAll(SECRET_REF)].filter(
      (m) => !(EXEMPT_SECRETS.has(m[1]) || m[0].includes("||"))
    );
    if (refs.length === 0) {
      continue;
    }
    anySecret = true;
    if (GATE_ID.test(id)) {
      continue;
    }
    const needs = job?.needs ? [job.needs].flat() : [];
    const gateIf = String(job?.if ?? "").replace(/\s+/g, "");
    if (!(needs.some((n) => GATE_ID.test(n)) && GATE_OUTPUT.test(gateIf))) {
      issues.push(`${name}: job "${id}" uses secrets without a secret-gate`);
    }
  }
  if (anySecret && !gateHasVisibleSkip) {
    issues.push(`${name}: secret use lacks a visible secret-gate skip`);
  }
  return issues;
}

export function allWorkflowSecretIssues(root = ".") {
  const dir = join(root, WORKFLOWS_DIR);
  return readdirSync(dir)
    .filter((file) => YAML_FILE.test(file))
    .sort()
    .flatMap((file) =>
      workflowSecretIssues(file, readFileSync(join(dir, file), "utf8"))
    );
}
