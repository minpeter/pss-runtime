// Security-workflow secret invariants (VAL-SEC-033), imported by
// scripts/security-workflow-secrets.test.mjs. Everything here is static over
// committed files: workflow YAML parsing plus a runbook text scan. No
// network, no ports, no writes, no clock.

import { parseWorkflowDocs } from "./workflow-docs.mjs";
import { envKeys, walkStrings } from "./workflow-walkers.mjs";

export const SECURITY_RUNBOOK_PATH =
  "docs/runbooks/security-scan-failure-triage.md";

// Security-workflow detection (CodeQL, gitleaks, OWASP ZAP): a workflow is a
// security workflow when its filename says so or any step invokes one of
// those tools, so the ZAP workflow is covered automatically once it lands.
const SECURITY_FILE = /(?:codeql|gitleaks|zap)[^/]*\.ya?ml$/i;
const SECURITY_USES = /^(?:github\/codeql-action\/|gitleaks\/|zaproxy\/)/;
const SECURITY_RUN = /\b(?:gitleaks|zaproxy|zap-baseline)\b/;

// An authored secret reference is any `secrets.` context use in a parsed
// workflow value; security workflows must reference none. The auto-injected
// `github.token` context is not an authored secret reference: it is
// permitted only inside an env value consumed by a tool and must never be
// printed or logged (never echoed from a run step).
const SECRETS_REF = /\bsecrets\./i;
const GITHUB_TOKEN = /\bgithub\.token\b/i;
const ENV_LOCATION = /(?:^|\.)env(?:\.|\[|$)/;

// Provider/Telegram credential env vars a security workflow must never set.
const CREDENTIAL_ENV =
  /^(?:AI_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET_TOKEN|WORKER_AGENT_TUI_)/;

function steps(doc) {
  return Object.values(doc?.jobs ?? {}).flatMap((job) => job?.steps ?? []);
}

export function isSecurityWorkflow({ path, doc }) {
  if (SECURITY_FILE.test(path)) {
    return true;
  }
  return steps(doc).some(
    (step) =>
      (typeof step?.uses === "string" && SECURITY_USES.test(step.uses)) ||
      (typeof step?.run === "string" && SECURITY_RUN.test(step.run))
  );
}

function workflowSecretProblems(path, doc) {
  const problems = [];
  const strings = [];
  walkStrings(doc, "", strings);
  for (const { location, value } of strings) {
    if (SECRETS_REF.test(value)) {
      problems.push(
        `${path} ${location} references an authored secret (secrets.*); security workflows must reference none`
      );
    }
    if (GITHUB_TOKEN.test(value) && !ENV_LOCATION.test(location)) {
      problems.push(
        `${path} ${location} references github.token outside an env value; the auto-injected token is permitted only as an env value consumed by a tool, never printed or logged`
      );
    }
  }
  for (const { location, key } of envKeys(doc)) {
    if (CREDENTIAL_ENV.test(key)) {
      problems.push(
        `${path} ${location} sets credential env var ${key}; security workflows must not set provider/Telegram credentials`
      );
    }
  }
  return problems;
}

// Paths of the workflows classified as security workflows (CodeQL, gitleaks,
// ZAP), so the test can prove the classification is not vacuous.
export function securityWorkflowPaths(workflows) {
  const problems = [];
  return parseWorkflowDocs(workflows, problems)
    .filter(isSecurityWorkflow)
    .map(({ path }) => path);
}

// Shipped-workflow invariants: at least one security workflow exists and no
// security workflow references an authored secret, sets a provider/Telegram
// credential env var, or prints/logs github.token.
export function securityWorkflowSecretsProblems(workflows) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems).filter(
    isSecurityWorkflow
  );
  if (docs.length === 0) {
    problems.push(
      "no security workflow (CodeQL, gitleaks, ZAP) found under .github/workflows"
    );
    return problems;
  }
  for (const { path, doc } of docs) {
    problems.push(...workflowSecretProblems(path, doc));
  }
  return problems;
}

// Runbook invariants: the security-scan runbook documents the workflow
// secret policy, including the permitted-but-never-printed github.token
// exception (VAL-SEC-033).
const RUNBOOK_RULES = [
  [
    /secrets\.\*/,
    "does not forbid authored secrets.* references in security workflows",
  ],
  [
    /AI_API_KEY|WORKER_AGENT_TUI_/,
    "does not name the forbidden provider/Telegram credential env vars",
  ],
  [/github\.token/, "does not document the permitted github.token exception"],
  [
    /env value/i,
    "does not restrict github.token to env values consumed by tools",
  ],
  [
    /never (?:be )?(?:printed|echoed|logged)/i,
    "does not state github.token is never printed or logged",
  ],
];

export function runbookSecretPolicyProblems(text) {
  return RUNBOOK_RULES.filter(([pattern]) => !pattern.test(text)).map(
    ([, message]) => `security-scan runbook ${message}`
  );
}
