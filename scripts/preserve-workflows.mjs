import { readFileSync } from "node:fs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

// Preservation invariants for the pre-mission install/build workflows and
// ignore rules (VAL-LOCAL-027, VAL-LOCAL-028). Every decision here is static
// over committed files: no network, no ports, no writes, no clock.

export const GITIGNORE_PATH = ".gitignore";
export const NPMIGNORE_PATH = ".npmignore";
export const PACKAGE_JSON_PATH = "package.json";
export const EXTENDED_WORKFLOW_PATH =
  ".github/workflows/extended-verification.yml";
export const WORKFLOW_PATHS = [
  ".github/workflows/ci.yml",
  EXTENDED_WORKFLOW_PATH,
  ".github/workflows/release.yml",
];

// Pre-mission .gitignore rule set, pinned by VAL-LOCAL-027. Membership is
// exact: a broader covering pattern never substitutes for a listed rule, so
// removals and silent rewrites both fail the invariant.
export const REQUIRED_GITIGNORE_PATTERNS = [
  "node_modules",
  ".DS_Store",
  "dist",
  "coverage",
  "AGENTS.md",
  "**/AGENTS.md",
  ".env",
  ".env.*",
  "!.env.example",
  ".dev.vars",
  ".dev.vars.*",
  "!.dev.vars.example",
  ".turbo",
  ".artifacts",
  "packages/*/.turbo",
  ".wrangler",
  ".omo/*",
  "!.omo/plans/",
  "!.omo/plans/**",
  ".senpi/",
];

// Pre-mission .npmignore rule set, pinned by VAL-LOCAL-027.
export const REQUIRED_NPMIGNORE_PATTERNS = [
  ".DS_Store",
  ".env",
  ".env.*",
  ".omo/",
  ".senpi/",
  "node_modules/",
  "!.env.example",
];

// Additive-only addition: analysis reports (Knip/jscpd/drift/bundle budgets)
// land under report/ and are never committed.
const REPORT_PATTERN = /^report\/?$/;

// Pre-mission root script keys, pinned by VAL-LOCAL-028. New scripts may be
// added; none of these may be renamed, repurposed, or removed.
export const REQUIRED_ROOT_SCRIPTS = [
  "api:check",
  "api:update",
  "audit",
  "boundaries",
  "build",
  "check:compatibility",
  "check:tegami-notes",
  "coverage",
  "dev",
  "dev:tui",
  "eval:edge-remote",
  "eval:provider",
  "format",
  "inspect:runtime-storage",
  "lint",
  "repo:affected",
  "repo:packages",
  "stress:runtime-storage",
  "stress:runtime-storage:extreme",
  "stress:runtime-storage:heavy",
  "stress:runtime-storage:torture",
  "tegami",
  "test",
  "test:cross-platform-smoke",
  "typecheck",
  "verify:edge",
  "verify:package-apis",
  "verify:release",
];

// Credentialed, live-provider paths: local exit-0 is never claimed for them;
// they run only behind the extended-verification secret-gate (VAL-LOCAL-028).
export const CREDENTIALED_SCRIPTS = ["eval:provider", "eval:edge-remote"];

const GATED_JOB_NAMES = {
  "eval:provider": "live-provider",
  "eval:edge-remote": "remote-edge",
};

export function readRepoFile(path) {
  return readFileSync(path, "utf8");
}

export function parsePatterns(source) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function missingPatterns(actual, required) {
  const present = new Set(actual);
  return required.filter((pattern) => !present.has(pattern));
}

export function ignoreProblems(label, source, required) {
  return missingPatterns(parsePatterns(source), required).map(
    (pattern) =>
      `${label} no longer lists the pre-existing pattern "${pattern}" (ignore rules are additive-only)`
  );
}

export function reportPatternProblems(source) {
  return parsePatterns(source).some((pattern) => REPORT_PATTERN.test(pattern))
    ? []
    : ['.gitignore lacks the additive "report/" pattern for analysis reports'];
}

export function scriptProblems(scripts) {
  return REQUIRED_ROOT_SCRIPTS.filter((key) => !(key in scripts)).map(
    (key) =>
      `root package.json no longer provides the pre-existing script "${key}"`
  );
}

// A credentialed eval script may run in exactly one place: its dedicated job
// in extended-verification.yml, and that job must declare
// `needs: secret-gate` so it never runs without the credential gate.

function jobRunText(job) {
  return (Array.isArray(job?.steps) ? job.steps : [])
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .join("\n");
}

function jobNeeds(job) {
  return [job?.needs ?? []].flat().map(String);
}

function collectInvocations(workflows, problems) {
  const invocations = [];
  for (const { path, doc } of parseWorkflowDocs(workflows, problems)) {
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      const runText = jobRunText(job);
      for (const script of CREDENTIALED_SCRIPTS) {
        if (runText.includes(script)) {
          invocations.push({
            path,
            jobName,
            script,
            gated: jobNeeds(job).includes("secret-gate"),
          });
        }
      }
    }
  }
  return invocations;
}

function ungatedProblems(invocations) {
  return invocations
    .filter((call) => call.path !== EXTENDED_WORKFLOW_PATH || !call.gated)
    .map(
      (call) =>
        `${call.script} runs in ${call.path} job "${call.jobName}" without the extended-verification secret-gate`
    );
}

function ownerProblems(invocations) {
  const problems = [];
  for (const [script, jobName] of Object.entries(GATED_JOB_NAMES)) {
    const matches = invocations.filter((call) => call.script === script);
    if (
      matches.length !== 1 ||
      matches[0].path !== EXTENDED_WORKFLOW_PATH ||
      matches[0].jobName !== jobName
    ) {
      problems.push(
        `${script} must run exactly once, in the secret-gated "${jobName}" job of extended-verification.yml`
      );
    }
  }
  return problems;
}

export function evalCarveoutProblems(workflows) {
  const problems = [];
  const invocations = collectInvocations(workflows, problems);
  return problems.concat(
    ungatedProblems(invocations),
    ownerProblems(invocations)
  );
}
