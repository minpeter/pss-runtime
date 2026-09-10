// Worker Wrangler lifecycle invariants (VAL-WORKER-034/035/037), imported by
// scripts/worker-lifecycle.test.mjs. Static over committed files only: no
// network, no ports, no writes, no clock.
//
// The validation startup contract is an explicit runtime build followed by
// the worker package's `dev:worker` script (`wrangler dev -e dev`) on the
// loopback binding pinned by scripts/security-egress-local.mjs. pnpm runs a
// `pre<name>` hook only for the exact script `<name>`, so the package's
// `predev` hook pairs with the combined `dev` script and never with
// `dev:worker`: renaming, merging, or re-hooking these scripts silently
// changes the contract, and this invariant fails.

import { readFileSync } from "node:fs";

export const WORKER_PACKAGE_JSON = "apps/worker-agent/package.json";
export const WORKER_HEALTH_RUNBOOK = "docs/runbooks/worker-health.md";

// The exact local dev-server command validators invoke after building the
// runtime explicitly.
export const DEV_WORKER_COMMAND = "wrangler dev -e dev";
const RUNTIME_BUILD_TOKEN = "@minpeter/pss-runtime build";

// Script keys the startup contract depends on; all four must exist as
// distinct entries so the validation path (build, then dev:worker) never
// overlaps the combined development script or the Telegram relay.
export const REQUIRED_SCRIPT_KEYS = [
  "predev",
  "dev",
  "dev:worker",
  "dev:relay",
];

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function workerScriptProblems(scripts) {
  const problems = [];
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return [`${WORKER_PACKAGE_JSON} has no scripts object`];
  }
  for (const key of REQUIRED_SCRIPT_KEYS) {
    if (typeof scripts[key] !== "string" || scripts[key].trim() === "") {
      problems.push(`${WORKER_PACKAGE_JSON} is missing the "${key}" script`);
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  if (scripts["dev:worker"] !== DEV_WORKER_COMMAND) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "dev:worker" must be exactly "${DEV_WORKER_COMMAND}", found "${scripts["dev:worker"]}"`
    );
  }
  if (!scripts.predev.includes(RUNTIME_BUILD_TOKEN)) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "predev" must build the runtime explicitly (${RUNTIME_BUILD_TOKEN})`
    );
  }
  if (
    !(scripts.dev.includes("dev:worker") && scripts.dev.includes("dev:relay"))
  ) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "dev" must remain the combined worker+relay script so validation never uses it`
    );
  }
  if (!scripts["dev:relay"].includes("telegram")) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "dev:relay" must remain the Telegram relay (never a validation step)`
    );
  }
  // A `predev:worker` hook would silently auto-build the runtime before
  // `dev:worker`, contradicting the explicit-build-first contract.
  if ("predev:worker" in scripts) {
    problems.push(
      `${WORKER_PACKAGE_JSON} must not declare "predev:worker"; the runtime build stays an explicit validation step`
    );
  }
  return problems;
}

// The worker-health runbook documents the ss/lsof lifecycle evidence
// procedure: before/after listener snapshots, a bounded readiness probe,
// read-only probes without secrets, clean teardown, and ignored working
// artifacts.
const EVIDENCE_MARKERS = [
  [/\bss -tln/, "an ss listener snapshot"],
  [/\blsof\b/, "an lsof listener listing"],
  [/\/healthz/, "the /healthz readiness probe"],
  [/within \d+ seconds/, "a bounded readiness budget"],
  [/\bSIGTERM\b/, "the teardown signal procedure"],
  [/\.wrangler/, "the ignored working-artifacts rule"],
];

export function runbookEvidenceProblems(text) {
  return EVIDENCE_MARKERS.filter(([pattern]) => !pattern.test(text)).map(
    ([, label]) =>
      `${WORKER_HEALTH_RUNBOOK} no longer documents ${label} for the local lifecycle evidence procedure`
  );
}
