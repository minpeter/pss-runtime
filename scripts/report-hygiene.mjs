import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_ROOTS, REPORT_TOOLS, ROOT_PROBES } from "./report-paths.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

// Report-hygiene invariants (VAL-SEC-008/009): every declared analysis report
// path is gitignore-covered, no report file is tracked, a post-run
// `git status` shows no report file, and CI reports travel only as bounded
// upload-artifact steps. Git access is read-only query processes
// (check-ignore / ls-files / status); nothing here writes, binds a port, or
// touches the network. The invariants live in scripts/report-hygiene.test.mjs.

export const GITIGNORE_PATH = ".gitignore";
export const WORKFLOWS_DIR = ".github/workflows";

// Bounded artifact retention: every upload-artifact step must declare an
// explicit retention-days within this ceiling so reports cannot accumulate.
export const MAX_ARTIFACT_RETENTION_DAYS = 30;

// `.omo/plans/` is the single un-ignored corner of the agent workspace (shared
// plans are committed on purpose); everything else report-shaped is a
// violation when tracked or dirty after an analysis run.
const PLANS_PREFIX = ".omo/plans/";

// The additive `report` rule (bare or dir form) required by VAL-SEC-008.
const REPORT_PATTERN = /^report\/?$/;

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}

export function parsePatterns(source) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function reportPatternProblems(source) {
  return parsePatterns(source).some((pattern) => REPORT_PATTERN.test(pattern))
    ? []
    : ['.gitignore lacks the additive "report" pattern for analysis reports'];
}

// Paths a full analysis run may produce: every registered report path plus
// the root variants (bare `report`, the `report/` directory, .omo/, .senpi/).
export function probePaths(tools = REPORT_TOOLS) {
  return [...ROOT_PROBES, ...tools.map((tool) => tool.path)].sort();
}

// `git check-ignore` must match each path; an unmatched path means a report
// written there would show up as an untracked file after the run.
export function uncoveredPathProblems(paths) {
  return paths
    .filter((path) => git(["check-ignore", "-q", "--", path]).status !== 0)
    .map(
      (path) =>
        `${path} is not matched by any .gitignore pattern (git check-ignore)`
    );
}

function isReportPath(path) {
  return (
    REPORT_ROOTS.some((root) => path.startsWith(root)) &&
    !path.startsWith(PLANS_PREFIX)
  );
}

// `git ls-files` filtered by the report roots must be empty: no report file
// is tracked by git.
export function trackedReportProblems() {
  const { stdout } = git(["ls-files", "-z", "--", "report", ".omo", ".senpi"]);
  return stdout
    .split("\0")
    .filter((path) => path !== "" && isReportPath(path))
    .map(
      (path) => `${path} is a git-tracked report file (never commit reports)`
    );
}

// After a full analysis run, `git status --porcelain` must not list a report
// file: report paths are ignored, so any appearance is a hygiene regression.
export function untrackedReportProblems(porcelain) {
  return porcelain
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).replace(QUOTED_PATH, "$1"))
    .filter(isReportPath)
    .map((path) => `git status lists report file ${path} after the run`);
}

export function workflowFiles(root = ".") {
  return readdirSync(join(root, WORKFLOWS_DIR))
    .filter((file) => YAML_FILE.test(file))
    .sort();
}

export function readWorkflows(root = ".") {
  return workflowFiles(root).map((file) => ({
    path: `${WORKFLOWS_DIR}/${file}`,
    source: readFileSync(join(root, WORKFLOWS_DIR, file), "utf8"),
  }));
}

const UPLOAD_ARTIFACT = /^actions\/upload-artifact[@/]/;
const GLOB_CHARS = /[*?[{]/;
const QUOTED_PATH = /^"(.*)"$/;
const YAML_FILE = /\.ya?ml$/;
const NON_DIR_TAIL = /[^/]*$/;
const LEADING_DOT_SLASH = /^\.\//;
const LEADING_SLASH = /^\//;
const TRAILING_SLASHES = /\/+$/;
const FORCE_ADD_REPORT =
  /git\s+add\s+(?:-[a-zA-Z]*f|--force)\b[^\n|]*\b(?:report|\.omo|\.senpi)\b/;

// A report-root reference reduced to a concrete probe: glob segments are
// replaced so `git check-ignore` can classify the static prefix.
function artifactProbe(token) {
  const staticPrefix = token.split(GLOB_CHARS)[0].replace(NON_DIR_TAIL, "");
  return `${staticPrefix}.probe`;
}

function reportRootToken(token) {
  const cleaned = token
    .replace(LEADING_DOT_SLASH, "")
    .replace(LEADING_SLASH, "");
  return REPORT_ROOTS.some((root) => cleaned.startsWith(root)) ||
    cleaned === "report"
    ? cleaned
    : null;
}

function artifactPathTokens(step) {
  return String(step?.with?.path ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function retentionProblems(label, step) {
  const retention = step?.with?.["retention-days"];
  if (
    typeof retention !== "number" ||
    !Number.isInteger(retention) ||
    retention < 1 ||
    retention > MAX_ARTIFACT_RETENTION_DAYS
  ) {
    return [
      `${label} upload-artifact lacks a bounded retention-days (1..${MAX_ARTIFACT_RETENTION_DAYS})`,
    ];
  }
  return [];
}

// A report path may be uploaded in CI only when its registry entry declares
// ci: "artifact" — gate-mode tools (knip, jscpd, drift, bundle budget) never
// upload reports.
function unregisteredArtifactProblems(label, tokens, tools) {
  const artifactPaths = tools
    .filter((tool) => tool.ci === "artifact")
    .map((tool) => tool.path);
  const problems = [];
  for (const token of tokens) {
    const cleaned = reportRootToken(token);
    if (cleaned === null) {
      continue;
    }
    const covered = artifactPaths.some(
      (path) => cleaned.startsWith(path) || path.startsWith(cleaned)
    );
    if (!covered) {
      problems.push(
        `${label} uploads report path "${token}" with no ci:"artifact" registry entry in scripts/report-paths.mjs`
      );
    }
  }
  return problems;
}

// Workflow hygiene over parsed CI definitions (VAL-SEC-008): CI-only reports
// are bounded upload-artifact steps, report paths are never force-staged or
// committed, and uploaded report paths are registered.
export function workflowArtifactProblems(workflows, tools = REPORT_TOOLS) {
  const problems = [];
  for (const { path, doc } of parseWorkflowDocs(workflows, problems)) {
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const [index, step] of (job?.steps ?? []).entries()) {
        const label = `${path} job "${jobName}" step ${index + 1}`;
        if (typeof step?.uses === "string" && UPLOAD_ARTIFACT.test(step.uses)) {
          problems.push(...retentionProblems(label, step));
          problems.push(
            ...unregisteredArtifactProblems(
              label,
              artifactPathTokens(step),
              tools
            )
          );
        }
        if (typeof step?.run === "string" && FORCE_ADD_REPORT.test(step.run)) {
          problems.push(
            `${label} force-stages report files (git add -f); reports are never committed`
          );
        }
      }
    }
  }
  return problems;
}

// Glob-bearing upload paths still need gitignore coverage; the probe reduces
// them to a static prefix for `git check-ignore`.

// True when an upload `with.path` token covers path: exact match, directory
// prefix, or a glob whose static prefix contains it. Shared by the
// report-hygiene CI checks and the analysis-tool producer wiring invariants
// (test-timing, flaky detection).
export function uploadPathCovers(token, path) {
  const cleaned = token
    .replace(LEADING_DOT_SLASH, "")
    .replace(TRAILING_SLASHES, "");
  if (cleaned === path) {
    return true;
  }
  if (GLOB_CHARS.test(cleaned)) {
    return path.startsWith(cleaned.split(GLOB_CHARS)[0]);
  }
  return path.startsWith(`${cleaned}/`);
}

function stepProbes(step) {
  if (typeof step?.uses !== "string" || !UPLOAD_ARTIFACT.test(step.uses)) {
    return [];
  }
  return artifactPathTokens(step)
    .map(reportRootToken)
    .filter((token) => token !== null)
    .map(artifactProbe);
}

export function artifactProbePaths(workflows) {
  const probes = [];
  for (const { doc } of parseWorkflowDocs(workflows, [])) {
    for (const job of Object.values(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        probes.push(...stepProbes(step));
      }
    }
  }
  return [...new Set(probes)].sort();
}
