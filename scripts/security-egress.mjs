// No-external-egress workflow invariants (VAL-SEC-040), imported by
// scripts/security-egress.test.mjs. Everything here is static over committed
// workflow YAML: no network, no ports, no writes, no clock. The example-env
// and loopback-binding invariants (VAL-SEC-041/042) live in
// security-egress-local.mjs, split out to stay under the 250 pure-LOC
// ceiling (scripts/file-size.test.mjs).

import { parseWorkflowDocs } from "./workflow-docs.mjs";
import { envKeys, walkStrings } from "./workflow-walkers.mjs";

export const GATED_WORKFLOW_PATH =
  ".github/workflows/extended-verification.yml";
export const GATED_JOBS = ["secret-gate", "live-provider", "remote-edge"];

// Credential env vars and real-mode eval flags that only the secret-gated
// extended-verification jobs may set. ci.yml and every analysis/security/
// release workflow must never set them.
const CREDENTIAL_ENV =
  /^(?:AI_API_KEY|AI_BASE_URL|AI_MODEL|PSS_EVAL_REAL|PSS_WORKER_AGENT_EVAL_REAL|WORKER_AGENT_TUI_|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET_TOKEN)/;
const CREDENTIAL_SECRET =
  /\bsecrets\.(?:AI_API_KEY|AI_BASE_URL|AI_MODEL|WORKER_AGENT_TUI_[A-Z0-9_]*|TELEGRAM_[A-Z0-9_]*)/;
// The credential-gated eval suites; they run only behind secret-gate, never
// in the fast gate (no local exit-0 claim applies to them).
const GATED_EVAL_RUN = /\beval:(?:provider|edge-remote)\b/;
const URL_TOKEN = /https?:\/\/[^\s"'`)\]}<>]+/g;
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Non-loopback hosts any workflow may reference by default: tool and action
// distribution endpoints only (action/tool downloads, the npm registry for
// the release OIDC setup). Anything else is a real external target.
const TOOL_HOST_SUFFIXES = [
  "github.com",
  "githubusercontent.com",
  "registry.npmjs.org",
];

// A dotted location path inside one of the secret-gated jobs, e.g.
// "jobs.live-provider.steps[4].env.AI_BASE_URL".
const GATED_JOB_LOCATION =
  /^jobs\.(?:secret-gate|live-provider|remote-edge)[.[]/;

function isLoopbackHost(host) {
  return host === "localhost" || host === "[::1]" || IPV4_LOOPBACK.test(host);
}

function isToolHost(host) {
  return TOOL_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

function urlProblems(path, location, value, gated) {
  const problems = [];
  for (const match of value.matchAll(URL_TOKEN)) {
    let host;
    try {
      host = new URL(match[0]).hostname;
    } catch {
      problems.push(`${path} ${location} has an unparseable URL ${match[0]}`);
      continue;
    }
    if (isLoopbackHost(host) || isToolHost(host)) {
      continue;
    }
    if (gated && GATED_JOB_LOCATION.test(location)) {
      continue;
    }
    problems.push(
      `${path} ${location} invokes non-loopback host ${host}; external calls are allowed only in the secret-gated ${GATED_WORKFLOW_PATH} jobs (${GATED_JOBS.join(", ")})`
    );
  }
  return problems;
}

function workflowEgressProblems(path, doc) {
  const gated = path === GATED_WORKFLOW_PATH;
  const problems = [];
  const strings = [];
  walkStrings(doc, "", strings);
  for (const { location, value } of strings) {
    const allowedHere = gated && GATED_JOB_LOCATION.test(location);
    const secretRef = value.match(CREDENTIAL_SECRET);
    if (secretRef && !allowedHere) {
      problems.push(
        `${path} ${location} references ${secretRef[0]}; only the secret-gated jobs of ${GATED_WORKFLOW_PATH} may reference provider/Telegram secrets`
      );
    }
    if (GATED_EVAL_RUN.test(value) && !allowedHere) {
      problems.push(
        `${path} ${location} runs a credential-gated eval (eval:provider/eval:edge-remote); these exist only behind secret-gate and are never part of local exit-0 claims`
      );
    }
    problems.push(...urlProblems(path, location, value, gated));
  }
  for (const { location, key } of envKeys(doc)) {
    const allowedHere = gated && GATED_JOB_LOCATION.test(location);
    if (CREDENTIAL_ENV.test(key) && !allowedHere) {
      problems.push(
        `${path} ${location} sets credential env var ${key}; only the secret-gated jobs of ${GATED_WORKFLOW_PATH} may do that`
      );
    }
  }
  return problems;
}

// The secret-gate structure: live-provider and remote-edge consume
// secret-gate outputs and run exactly the gated eval suites.
function secretGateProblems(doc) {
  const problems = [];
  const jobs = doc?.jobs ?? {};
  for (const name of GATED_JOBS) {
    if (!jobs[name]) {
      problems.push(`${GATED_WORKFLOW_PATH} lacks the ${name} job`);
    }
  }
  const expectations = [
    ["live-provider", "provider", "eval:provider"],
    ["remote-edge", "remote_edge", "eval:edge-remote"],
  ];
  for (const [name, output, command] of expectations) {
    const job = jobs[name];
    if (!job) {
      continue;
    }
    const needs = [job.needs ?? []].flat();
    if (!needs.includes("secret-gate")) {
      problems.push(`${name} does not declare needs: secret-gate`);
    }
    const gateRef = `needs.secret-gate.outputs.${output}`;
    if (!String(job.if ?? "").includes(gateRef)) {
      problems.push(
        `${name} is not gated on ${gateRef}; it would run without detected credentials`
      );
    }
    const runs = (job.steps ?? [])
      .map((step) => String(step?.run ?? ""))
      .join("\n");
    if (!runs.includes(command)) {
      problems.push(`${name} does not run pnpm ${command}`);
    }
  }
  return problems;
}

export function externalEgressProblems(workflows) {
  const problems = [];
  const docs = parseWorkflowDocs(workflows, problems);
  const gated = docs.find(({ path }) => path === GATED_WORKFLOW_PATH);
  if (!gated) {
    problems.push(
      `${GATED_WORKFLOW_PATH} is missing; external calls have no secret-gated home`
    );
  }
  for (const { path, doc } of docs) {
    problems.push(...workflowEgressProblems(path, doc));
  }
  if (gated) {
    problems.push(...secretGateProblems(gated.doc));
  }
  return problems;
}
