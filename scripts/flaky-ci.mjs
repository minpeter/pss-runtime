// Flaky-detection CI and Vitest-config invariants (VAL-SEC-025/026), imported
// by scripts/flaky-ci.test.mjs. Everything here is static over committed
// files: workflow YAML parsing, trigger/step shape checks, and a retry scan
// of checked-in Vitest configs. No network, no ports, no writes.

import { spawnSync } from "node:child_process";
import {
  MAX_ARTIFACT_RETENTION_DAYS,
  uploadPathCovers,
} from "./report-hygiene.mjs";
import { reportTool } from "./report-paths.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const FLAKY_TOOL = reportTool("flaky");

// A producer step invokes the root script (pnpm test:flaky) or the producer
// module directly.
const PRODUCER_RUN =
  /(^|\s)(pnpm\s+(run\s+)?)?test:flaky(\s|$)|scripts\/flaky-tests\.mjs/;

// The detection workflow may ONLY be triggered by schedule or manual
// dispatch; the fast CI triggers must never carry a flaky step.
const DETECTION_TRIGGERS = new Set(["schedule", "workflow_dispatch"]);
const FAST_TRIGGERS = new Set(["pull_request", "push"]);

// Explicit numeric bounds the producer step must declare.
const RUNS_FLAG = /--runs\s+([1-9]\d*)(\s|$)/;
const TIMEOUT_FLAG = /--timeout\s+([1-9]\d*)(\s|$)/;

const UPLOAD_ARTIFACT = /^actions\/upload-artifact[@/]/;

// GitHub's `on:` parses as a string, a list, or a map depending on form.
export function triggerSet(on) {
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.map(String);
  }
  if (on !== null && typeof on === "object") {
    return Object.keys(on);
  }
  return [];
}

function producerInvocations(workflows, problems) {
  const invocations = [];
  for (const { path, doc } of parseWorkflowDocs(workflows, problems)) {
    const triggers = triggerSet(doc?.on);
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (typeof step?.run === "string" && PRODUCER_RUN.test(step.run)) {
          invocations.push({ path, triggers, jobName, job, step });
        }
      }
    }
  }
  return invocations;
}

function boundedUploadExists(workflows, problems) {
  for (const { doc } of parseWorkflowDocs(workflows, problems)) {
    for (const job of Object.values(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (
          typeof step?.uses !== "string" ||
          !UPLOAD_ARTIFACT.test(step.uses)
        ) {
          continue;
        }
        const tokens = String(step?.with?.path ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        const retention = step?.with?.["retention-days"];
        const bounded =
          Number.isInteger(retention) &&
          retention >= 1 &&
          retention <= MAX_ARTIFACT_RETENTION_DAYS;
        if (
          tokens.some((token) => uploadPathCovers(token, FLAKY_TOOL.path)) &&
          bounded
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function invocationProblems({ path, triggers, jobName, job, step }) {
  const label = `${path} job "${jobName}"`;
  const problems = [];
  if (
    triggers.length === 0 ||
    !triggers.every((trigger) => DETECTION_TRIGGERS.has(trigger))
  ) {
    problems.push(
      `${label} runs flaky detection outside the schedule/workflow_dispatch triggers`
    );
  }
  if (triggers.some((trigger) => FAST_TRIGGERS.has(trigger))) {
    problems.push(
      `${label} puts a flaky step in the fast CI (pull_request/push) trigger set`
    );
  }
  if (!RUNS_FLAG.test(step.run)) {
    problems.push(
      `${label} flaky step lacks an explicit numeric --runs repeat count`
    );
  }
  if (!TIMEOUT_FLAG.test(step.run)) {
    problems.push(
      `${label} flaky step lacks a bounded numeric --timeout per run`
    );
  }
  if (typeof job?.["timeout-minutes"] !== "number") {
    problems.push(`${label} lacks a bounded job timeout-minutes`);
  }
  return problems;
}

// CI wiring invariants (VAL-SEC-025): some workflow runs the producer, every
// producer invocation is gated to schedule/workflow_dispatch with explicit
// numeric repeats and bounded timeouts, no pull_request/push-triggered
// workflow carries a flaky step, and the report travels as a bounded
// upload-artifact step.
export function flakyCiProblems(workflows) {
  const problems = [];
  const invocations = producerInvocations(workflows, problems);
  if (invocations.length === 0) {
    problems.push(
      "no workflow step runs the flaky detection producer (test:flaky)"
    );
  }
  for (const invocation of invocations) {
    problems.push(...invocationProblems(invocation));
  }
  if (!boundedUploadExists(workflows, problems)) {
    problems.push(`no bounded upload-artifact step uploads ${FLAKY_TOOL.path}`);
  }
  return problems;
}

// A `retry:` setting whose value is not the literal 0 masks failures; a
// non-literal expression could evaluate above zero and is rejected too.
const RETRY_SETTING = /\bretry\s*:\s*([^,}\n]+)/g;

// Checked-in Vitest configs must never enable the built-in retry
// (VAL-SEC-026): no `retry` key, or an explicit `retry: 0`.
export function vitestRetryProblems(configs) {
  const problems = [];
  for (const { path, source } of configs) {
    for (const match of source.matchAll(RETRY_SETTING)) {
      const value = match[1].trim();
      if (value !== "0") {
        problems.push(
          `${path} sets Vitest retry to ${value}; a single failing run must be reported failed, never auto-masked (omit retry or set retry: 0)`
        );
      }
    }
  }
  return problems;
}

// Every tracked Vitest config, root-level and nested. Both pathspecs are
// required: `**/x` alone does not match root-level files.
export function vitestConfigPaths() {
  const result = spawnSync(
    "git",
    ["ls-files", "--", "vitest*.config.*", "**/vitest*.config.*"],
    { encoding: "utf8" }
  );
  return (result.stdout ?? "")
    .split("\n")
    .filter((path) => path !== "")
    .sort();
}
