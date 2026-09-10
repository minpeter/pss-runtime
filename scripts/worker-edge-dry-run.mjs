// Edge dry-run build invariants (VAL-WORKER-038), imported by
// scripts/worker-edge-dry-run.test.mjs. Static over committed files only: no
// network, no ports, no writes, no clock.
//
// The contract: root `verify:edge` is exactly
// `pnpm --filter @minpeter/pss-worker-agent build`; the package `prebuild`
// builds the runtime first and `build` is a `wrangler deploy --dry-run
// --env=""` with the wrangler banner (update check) and metrics disabled —
// a local bundle of src/index.ts for the real edge runtime that needs no
// credentials, performs zero egress, never deploys, and is the exact
// command extended-verification.yml's edge-dry-run job runs. The real
// deploy stays in the separate manual `ship:worker` script, never in CI.

import { readFileSync } from "node:fs";
import { parseJsonc } from "./jsonc.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const ROOT_PACKAGE_JSON = "package.json";
export const WORKER_PACKAGE_JSON = "apps/worker-agent/package.json";
export const WRANGLER_CONFIG_PATH = "apps/worker-agent/wrangler.jsonc";
export const EXTENDED_WORKFLOW_PATH =
  ".github/workflows/extended-verification.yml";

export const VERIFY_EDGE_COMMAND =
  "pnpm --filter @minpeter/pss-worker-agent build";
// WRANGLER_HIDE_BANNER suppresses the banner's npm-registry update check
// (whose "update available" line also breaks byte-identical output) and
// WRANGLER_SEND_METRICS opts out of wrangler telemetry, so the dry-run
// build observes zero egress on any machine state.
export const WORKER_BUILD_COMMAND =
  'WRANGLER_HIDE_BANNER=true WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --env=""';
export const RUNTIME_BUILD_TOKEN = "@minpeter/pss-runtime build";
export const WORKER_ENTRYPOINT = "src/index.ts";
export const EDGE_DRY_RUN_JOB = "edge-dry-run";

const DRY_RUN_FLAG = "--dry-run";
const DEPLOY_PATTERN = /wrangler\s+deploy/;
const SECRET_REF_PATTERN = /secrets\./;
const VERIFY_EDGE_TOKEN = "verify:edge";

export function workflowSources(paths = [EXTENDED_WORKFLOW_PATH]) {
  return paths.map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

// --- The root -> package command chain -------------------------------------

export function verifyEdgeScriptProblems(rootScripts, workerScripts) {
  const problems = [];
  if (rootScripts?.[VERIFY_EDGE_TOKEN] !== VERIFY_EDGE_COMMAND) {
    problems.push(
      `${ROOT_PACKAGE_JSON} "verify:edge" must be exactly "${VERIFY_EDGE_COMMAND}", found "${rootScripts?.[VERIFY_EDGE_TOKEN]}"`
    );
  }
  const build = workerScripts?.build ?? "";
  if (build !== WORKER_BUILD_COMMAND) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "build" must be exactly "${WORKER_BUILD_COMMAND}", found "${build}"`
    );
  }
  if (!build.includes(DRY_RUN_FLAG)) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "build" lost the ${DRY_RUN_FLAG} flag; the edge check must never deploy`
    );
  }
  for (const suppression of [
    "WRANGLER_HIDE_BANNER=true",
    "WRANGLER_SEND_METRICS=false",
  ]) {
    if (!build.includes(suppression)) {
      problems.push(
        `${WORKER_PACKAGE_JSON} "build" lost ${suppression}; the edge check must observe zero egress`
      );
    }
  }
  if (!(workerScripts?.prebuild ?? "").includes(RUNTIME_BUILD_TOKEN)) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "prebuild" must build the runtime explicitly (${RUNTIME_BUILD_TOKEN})`
    );
  }
  const ship = workerScripts?.["ship:worker"] ?? "";
  if (!DEPLOY_PATTERN.test(ship) || ship.includes(DRY_RUN_FLAG)) {
    problems.push(
      `${WORKER_PACKAGE_JSON} "ship:worker" must remain the real (non-dry-run) manual deploy, found "${ship}"`
    );
  }
  return problems;
}

// --- The bundled entrypoint -------------------------------------------------

export function entrypointProblems(source) {
  let config;
  try {
    config = parseJsonc(source);
  } catch (error) {
    return [`${WRANGLER_CONFIG_PATH} parse error: ${error.message}`];
  }
  return config?.main === WORKER_ENTRYPOINT
    ? []
    : [
        `${WRANGLER_CONFIG_PATH} "main" must bundle ${WORKER_ENTRYPOINT}, found "${config?.main}"`,
      ];
}

// --- The CI reference --------------------------------------------------------

function jobRunSteps(job) {
  return (Array.isArray(job?.steps) ? job.steps : [])
    .map((step) => (typeof step?.run === "string" ? step.run.trim() : ""))
    .filter((run) => run !== "");
}

function jobNeedsSecretGate(job) {
  return [job?.needs ?? []].flat().map(String).includes("secret-gate");
}

function jobReferencesSecrets(job) {
  const envBlocks = [job?.env ?? {}].concat(
    (Array.isArray(job?.steps) ? job.steps : []).map((step) => step?.env ?? {})
  );
  return envBlocks.some((env) => SECRET_REF_PATTERN.test(JSON.stringify(env)));
}

function scanWorkflowRuns(workflows, problems) {
  const invocations = [];
  for (const { path, doc } of parseWorkflowDocs(workflows, problems)) {
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const run of jobRunSteps(job)) {
        if (run.includes(VERIFY_EDGE_TOKEN)) {
          invocations.push({ path, jobName, job, run });
        }
        if (DEPLOY_PATTERN.test(run) && !run.includes(DRY_RUN_FLAG)) {
          problems.push(
            `${path} job "${jobName}" runs a real wrangler deploy; CI must never deploy`
          );
        }
      }
    }
  }
  return invocations;
}

function placementProblems(invocations) {
  const [first] = invocations;
  return invocations.length === 1 &&
    first.path === EXTENDED_WORKFLOW_PATH &&
    first.jobName === EDGE_DRY_RUN_JOB
    ? []
    : [
        `pnpm ${VERIFY_EDGE_TOKEN} must run exactly once, in the "${EDGE_DRY_RUN_JOB}" job of ${EXTENDED_WORKFLOW_PATH}`,
      ];
}

export function edgeJobProblems(workflows) {
  const problems = [];
  const invocations = scanWorkflowRuns(workflows, problems);
  const placement = placementProblems(invocations);
  if (placement.length > 0) {
    return problems.concat(placement);
  }
  const [{ job, run }] = invocations;
  if (run !== `pnpm ${VERIFY_EDGE_TOKEN}`) {
    problems.push(
      `${EXTENDED_WORKFLOW_PATH} job "${EDGE_DRY_RUN_JOB}" must run exactly "pnpm ${VERIFY_EDGE_TOKEN}", found "${run}"`
    );
  }
  if (jobNeedsSecretGate(job)) {
    problems.push(
      `${EXTENDED_WORKFLOW_PATH} job "${EDGE_DRY_RUN_JOB}" must not need secret-gate; the dry-run build requires no credentials`
    );
  }
  if (jobReferencesSecrets(job)) {
    problems.push(
      `${EXTENDED_WORKFLOW_PATH} job "${EDGE_DRY_RUN_JOB}" must not reference repository secrets; the dry-run build is credential-free`
    );
  }
  return problems;
}
