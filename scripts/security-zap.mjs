// OWASP ZAP baseline workflow invariants (VAL-SEC-034..037), imported by
// scripts/security-zap.test.mjs. Everything here is static over committed
// files: workflow YAML parsing plus a ci.yml text scan. No network, no
// ports, no writes, no clock.

import { triggerSet } from "./flaky-ci.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const ZAP_WORKFLOW_FILE = "zap.yml";
export const ZAP_WORKFLOW_PATH = `.github/workflows/${ZAP_WORKFLOW_FILE}`;
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

// A workflow is a ZAP workflow when its filename says so or any step invokes
// the zaproxy baseline action / zap-baseline script.
const ZAP_FILE = /(?:^|\/)zap[^/]*\.ya?ml$/i;
const ZAP_USES = /^zaproxy\//;
const ZAP_RUN = /\bzap-baseline\b/;

// Global pinning policy: full 40-hex commit SHA (parsed `uses:` value) with
// a trailing version comment on the same source line (`@<sha> # vX.Y.Z`).
const PINNED_ZAP_ACTION = /^zaproxy\/action-baseline@[0-9a-f]{40}$/;
const PINNED_ACTION_LINE =
  /^[^\n]*zaproxy\/action-baseline@[0-9a-f]{40}\s+#\s*v\S+.*$/m;

// The scan target may ONLY come from the declared workflow_dispatch input.
const TARGET_EXPR =
  /^\$\{\{\s*(?:inputs|github\.event\.inputs)\.target-url\s*\}\}$/;
const NONEMPTY_GUARD = /inputs\.target-url\s*!=\s*''/;
const EMPTY_GUARD = /inputs\.target-url\s*==\s*''/;
const SKIP_WORD = /\bskip/i;

// Scope guards: no hardcoded host anywhere in the job steps and never a
// loopback address (the default target is EMPTY, never 127.0.0.1/localhost).
const HARD_CODED_URL = /https?:\/\//;
const LOOPBACK = /\b(?:127\.0\.0\.1|::1|localhost)\b/i;

// Bounded job timeout window in minutes (a concrete timeout-minutes).
const MAX_TIMEOUT_MINUTES = 60;

function jobSteps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function usesZap(step) {
  return typeof step?.uses === "string" && ZAP_USES.test(step.uses);
}

function isZapWorkflow({ path, doc }) {
  if (ZAP_FILE.test(path)) {
    return true;
  }
  return Object.values(doc?.jobs ?? {}).some((job) =>
    jobSteps(job).some(
      (step) =>
        usesZap(step) ||
        (typeof step?.run === "string" && ZAP_RUN.test(step.run))
    )
  );
}

// VAL-SEC-034: workflow_dispatch only — never push, pull_request, schedule.
function triggerProblems(path, doc) {
  const triggers = triggerSet(doc?.on);
  if (triggers.length === 1 && triggers[0] === "workflow_dispatch") {
    return [];
  }
  return [
    `${path} must be triggered by workflow_dispatch only (no push/pull_request/schedule); found: ${
      triggers.join(", ") || "none"
    }`,
  ];
}

// VAL-SEC-034/035: a required target-url input whose default is EMPTY.
function inputProblems(path, doc) {
  const input = doc?.on?.workflow_dispatch?.inputs?.["target-url"];
  if (input === null || typeof input !== "object") {
    return [
      `${path} workflow_dispatch lacks the required target-url string input`,
    ];
  }
  const problems = [];
  if (input.required !== true) {
    problems.push(`${path} target-url input must declare required: true`);
  }
  const fallback = input.default ?? "";
  if (typeof fallback !== "string" || fallback.trim() !== "") {
    problems.push(
      `${path} target-url default must be EMPTY (never loopback, never any host); found "${String(
        input.default
      )}"`
    );
  }
  return problems;
}

function scanStepProblems(path, jobName, scan) {
  const label = `${path} job "${jobName}"`;
  const problems = [];
  if (!PINNED_ZAP_ACTION.test(scan.uses)) {
    problems.push(
      `${label} action "${scan.uses}" is not pinned to a 40-hex SHA with a trailing version comment`
    );
  }
  if (!NONEMPTY_GUARD.test(String(scan.if ?? ""))) {
    problems.push(
      `${label} scan step must be guarded by if: on a non-empty target-url input`
    );
  }
  const target = String(scan.with?.target ?? "");
  if (!TARGET_EXPR.test(target)) {
    problems.push(
      `${label} scan target must come from the target-url input expression, never a hardcoded host`
    );
  }
  if (HARD_CODED_URL.test(String(scan.with?.cmd_options ?? ""))) {
    problems.push(
      `${label} cmd_options must not declare any host; the spider stays scoped to the declared target's host`
    );
  }
  return problems;
}

function skipStepProblems(path, jobName, steps) {
  const skip = steps.find(
    (step) =>
      EMPTY_GUARD.test(String(step?.if ?? "")) && typeof step?.run === "string"
  );
  if (!skip) {
    return [
      `${path} job "${jobName}" has no skip step guarded by an empty target-url input`,
    ];
  }
  if (!SKIP_WORD.test(skip.run)) {
    return [
      `${path} job "${jobName}" skip step must log an explicit skip message`,
    ];
  }
  return [];
}

// No step may hardcode an http(s) host. The validation script may name
// loopback hosts to reject them; other step fields may not target them.
function hardcodedHostProblems(path, jobName, steps) {
  const problems = [];
  for (const [index, step] of steps.entries()) {
    const text = JSON.stringify(step);
    const label = `${path} job "${jobName}" step ${index + 1}`;
    if (HARD_CODED_URL.test(text)) {
      problems.push(
        `${label} hardcodes an http(s) host; the scan scope stays the declared target-url input`
      );
    }
    const targetFields = JSON.stringify({
      ...step,
      run: step.id === "validate-target" ? undefined : step.run,
    });
    if (LOOPBACK.test(targetFields)) {
      problems.push(
        `${label} references a loopback address; ZAP never targets loopback/localhost by default`
      );
    }
  }
  return problems;
}

// VAL-SEC-035/037: bounded timeout-minutes and contents: read with no write.
function jobBoundProblems(path, doc, jobName, job) {
  const label = `${path} job "${jobName}"`;
  const problems = [];
  const timeout = job?.["timeout-minutes"];
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_TIMEOUT_MINUTES
  ) {
    problems.push(
      `${label} must declare a bounded timeout-minutes (1..${MAX_TIMEOUT_MINUTES})`
    );
  }
  const effective = job?.permissions ?? doc?.permissions;
  if (effective === null || typeof effective !== "object") {
    problems.push(`${label} lacks an explicit minimal permissions block`);
    return problems;
  }
  if (effective.contents !== "read") {
    problems.push(`${label} must declare permissions contents: read`);
  }
  for (const block of [doc?.permissions, job?.permissions]) {
    if (block === null || typeof block !== "object") {
      continue;
    }
    for (const [scope, value] of Object.entries(block)) {
      if (value === "write") {
        problems.push(
          `${label} grants "${scope}: write"; no write scope is allowed`
        );
      }
    }
  }
  return problems;
}

function workflowProblems(path, source, doc) {
  const problems = [...triggerProblems(path, doc), ...inputProblems(path, doc)];
  if (!PINNED_ACTION_LINE.test(source)) {
    problems.push(
      `${path} action reference lacks a trailing version comment on the uses line (\`@<40-hex-sha> # vX.Y.Z\`)`
    );
  }
  const scanJobs = Object.entries(doc?.jobs ?? {}).filter(([, job]) =>
    jobSteps(job).some(usesZap)
  );
  if (scanJobs.length === 0) {
    problems.push(`${path} has no zaproxy/action-baseline scan step`);
    return problems;
  }
  for (const [jobName, job] of scanJobs) {
    const steps = jobSteps(job);
    const scan = steps.find(usesZap);
    problems.push(...scanStepProblems(path, jobName, scan));
    problems.push(...skipStepProblems(path, jobName, steps));
    problems.push(...hardcodedHostProblems(path, jobName, steps));
    problems.push(...jobBoundProblems(path, doc, jobName, job));
  }
  return problems;
}

// Shipped-workflow invariants: exactly the ZAP-classified workflows must
// satisfy the manual-target-only, empty-default, bounded, read-only shape.
export function zapProblems(workflows) {
  const problems = [];
  const sources = new Map(workflows.map(({ path, source }) => [path, source]));
  const docs = parseWorkflowDocs(workflows, problems).filter(isZapWorkflow);
  if (docs.length === 0) {
    problems.push(
      "no OWASP ZAP baseline workflow found under .github/workflows"
    );
    return problems;
  }
  for (const { path, doc } of docs) {
    problems.push(...workflowProblems(path, sources.get(path) ?? "", doc));
  }
  return problems;
}

// VAL-SEC-036: the fast CI gate never references ZAP (no step, no workflow
// file reference); the ZAP workflow is a distinct, manually-dispatched file.
const ZAP_WORD = /zap/i;

export function ciZapProblems(ciSource) {
  return ZAP_WORD.test(ciSource)
    ? [
        `${CI_WORKFLOW_PATH} references ZAP; the fast CI gate must never invoke the ZAP workflow`,
      ]
    : [];
}
