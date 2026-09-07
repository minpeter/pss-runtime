import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const RUNBOOKS_DIR = "docs/runbooks";
export const INDEX_FILE = "README.md";
export const WORKFLOWS_DIR = ".github/workflows";
export const WORKER_HEALTH_FILE = "worker-health.md";
export const CI_RUNBOOK_FILE = "ci-failure-triage.md";

// Ports that mission workers must never bind or reference; 8792 is the only
// permitted local Worker port and is intentionally NOT in this set.
export const OFF_LIMITS_PORTS = ["8788", "3000", "3401", "3402"];

// The only secret names a runbook may name, and only as placeholders.
export const PLACEHOLDER_SECRETS = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "WORKER_AGENT_TUI_ENDPOINT",
  "WORKER_AGENT_TUI_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET_TOKEN",
];

// Each required operational topic and the link-text pattern that maps it to a
// runbook in the index.
export const REQUIRED_TOPICS = [
  { key: "ci-failure-triage", pattern: /\bci\b.*(fail|triage)/i },
  { key: "release-procedure", pattern: /release/i },
  { key: "extended-verification", pattern: /extended verification/i },
  {
    key: "worker-health",
    pattern: /worker health|worker.*operational|operational check/i,
  },
  { key: "security-scan", pattern: /security[- ]scan/i },
];

const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const LEADING_DOT_SLASH = /^\.\//;
const URL_SCHEME = /^[a-z]+:\/\//i;
const WORKFLOW_FILE = /`([A-Za-z0-9._-]+\.ya?ml)`/g;
const PAIR = /`([A-Za-z0-9._-]+\.ya?ml)`\s+(job|step)\s+`([^`]+)`/gi;
const PNPM_TOKEN = /pnpm(?:\s+run)?\s+([A-Za-z0-9:_-]+)/g;
const HEADING = /^#+\s+(.*\S)\s*$/;
const BARE_DEV = /pnpm dev(?![:\w-])/;
const DEV_RELAY = /dev:relay/;
const MONITORING_TERM = /\b(?:production|monitoring|uptime)\b/i;
const DEFERRAL_MARKER =
  /\b(?:deferred|external|out of scope|planned|not claimed|not verified|cannot)\b/i;
const SECRET_VALUE =
  /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/;
const PROD_MUTATION =
  /npm publish|pnpm publish|wrangler deploy|curl[^\n]*api\.telegram/i;
const SECRETY_NAME = /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*\b/g;
const YAML_EXT = /\.ya?ml$/;
const FAST_GATE = /fast gate/i;
const WORKER_LOCAL_PORT = /127\.0\.0\.1:8792/;
const DEV_WORKER = /dev:worker/;
const RUNTIME_BUILD = /pnpm --filter @minpeter\/pss-runtime build/;

export function readRunbook(name, root = ".") {
  return readFileSync(join(root, RUNBOOKS_DIR, name), "utf8");
}

export function readIndex(root = ".") {
  return readRunbook(INDEX_FILE, root);
}

export function runbookDirFiles(root = ".") {
  const dir = join(root, RUNBOOKS_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((file) => !file.startsWith("."));
}

// Files in the runbook directory that are not markdown (VAL-GOV-029).
export function nonMarkdownFiles(root = ".") {
  return runbookDirFiles(root).filter((file) => !file.endsWith(".md"));
}

// Runbook content files: every `.md` except the index itself.
export function runbookMarkdownFiles(root = ".") {
  return runbookDirFiles(root).filter(
    (file) => file.endsWith(".md") && file !== INDEX_FILE
  );
}

export function indexLinks(text) {
  const links = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    links.push({ text: match[1], target: match[2].split("#")[0].trim() });
  }
  return links;
}

// Link targets that point at a runbook file in the same directory (no path
// separator, ends in `.md`). Links to other docs (e.g. `../foo.md`) are not
// runbook files and are excluded here.
export function runbookLinkTargets(text) {
  return indexLinks(text)
    .map((link) => link.target.replace(LEADING_DOT_SLASH, ""))
    .filter((target) => target.endsWith(".md") && !target.includes("/"));
}

// Runbook files that exist on disk but are not linked from the index.
export function orphanRunbooks(text, root = ".") {
  const linked = new Set(runbookLinkTargets(text));
  return runbookMarkdownFiles(root).filter((file) => !linked.has(file));
}

// Index links to same-directory runbook files that do not exist on disk.
export function danglingRunbookLinks(text, root = ".") {
  const files = new Set(runbookMarkdownFiles(root));
  return runbookLinkTargets(text).filter((target) => !files.has(target));
}

// Every non-URL index link that does not resolve on disk (VAL-GOV-029).
export function unresolvedLinks(text, root = ".") {
  const bad = [];
  for (const { target } of indexLinks(text)) {
    if (URL_SCHEME.test(target) || target.startsWith("mailto:")) {
      continue;
    }
    const rel = target.replace(LEADING_DOT_SLASH, "");
    if (!existsSync(join(root, RUNBOOKS_DIR, rel))) {
      bad.push(target);
    }
  }
  return bad;
}

// Required topics with no index link whose text matches and whose target is an
// existing runbook (VAL-GOV-030).
export function unmappedTopics(text, root = ".") {
  const links = indexLinks(text);
  return REQUIRED_TOPICS.filter(
    (topic) =>
      !links.some(
        (link) =>
          topic.pattern.test(link.text) &&
          !link.target.includes("/") &&
          existsSync(
            join(root, RUNBOOKS_DIR, link.target.replace(LEADING_DOT_SLASH, ""))
          )
      )
  ).map((topic) => topic.key);
}

export function parseWorkflows(root = ".") {
  const dir = join(root, WORKFLOWS_DIR);
  const map = {};
  for (const file of readdirSync(dir).filter((f) => YAML_EXT.test(f))) {
    const doc = parse(readFileSync(join(dir, file), "utf8"));
    const jobs = doc?.jobs ?? {};
    const jobNames = new Set(Object.keys(jobs));
    const stepNames = new Set();
    for (const job of Object.values(jobs)) {
      for (const step of job?.steps ?? []) {
        if (typeof step?.name === "string") {
          stepNames.add(step.name);
        }
      }
    }
    map[file] = { jobs: jobNames, steps: stepNames };
  }
  return map;
}

export function citedWorkflowFiles(text) {
  return [...text.matchAll(WORKFLOW_FILE)].map((match) => match[1]);
}

// Backticked workflow-file citations that do not exist under
// `.github/workflows/` (VAL-GOV-031).
export function unresolvedWorkflowFiles(text, root = ".") {
  const dir = join(root, WORKFLOWS_DIR);
  return [...new Set(citedWorkflowFiles(text))].filter(
    (file) => !existsSync(join(dir, file))
  );
}

export function citedJobSteps(text) {
  return [...text.matchAll(PAIR)].map((match) => ({
    file: match[1],
    kind: match[2].toLowerCase(),
    name: match[3],
  }));
}

// Job/step citations whose name is absent from the cited workflow's parsed YAML
// (VAL-GOV-031).
export function unresolvedJobSteps(text, root = ".") {
  const workflows = parseWorkflows(root);
  const bad = [];
  for (const citation of citedJobSteps(text)) {
    const entry = workflows[citation.file];
    if (!entry) {
      bad.push(citation);
      continue;
    }
    const pool = citation.kind === "job" ? entry.jobs : entry.steps;
    if (!pool.has(citation.name)) {
      bad.push(citation);
    }
  }
  return bad;
}

// Root scripts (and pnpm subcommands) invoked by steps of the `ci.yml` `checks`
// job (VAL-GOV-032).
export function ciGateScripts(root = ".") {
  const doc = parse(readFileSync(join(root, WORKFLOWS_DIR, "ci.yml"), "utf8"));
  const steps = doc?.jobs?.checks?.steps ?? [];
  const scripts = new Set();
  for (const step of steps) {
    for (const match of String(step?.run ?? "").matchAll(PNPM_TOKEN)) {
      scripts.add(match[1]);
    }
  }
  return scripts;
}

export function sectionText(text, pattern) {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => HEADING.test(line) && pattern.test(line)
  );
  if (start === -1) {
    return "";
  }
  const rest = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) {
      break;
    }
    rest.push(line);
  }
  return rest.join("\n");
}

// pnpm commands the CI runbook attributes to the fast gate (VAL-GOV-032).
export function ciGateClaims(text) {
  const section = sectionText(text, FAST_GATE);
  return [...section.matchAll(PNPM_TOKEN)].map((match) => match[1]);
}

export function unsupportedGateClaims(text, root = ".") {
  const scripts = ciGateScripts(root);
  return [...new Set(ciGateClaims(text))].filter(
    (token) => !scripts.has(token)
  );
}

export function offLimitsPortHits(text) {
  return OFF_LIMITS_PORTS.filter((port) =>
    new RegExp(`(?<!\\d)${port}(?!\\d)`).test(text)
  );
}

export function usesBareDevCommand(text) {
  return BARE_DEV.test(text);
}

export function usesDevRelay(text) {
  return DEV_RELAY.test(text);
}

// Worker-health runbook must document the runtime build, then dev:worker on the
// permitted local port (VAL-GOV-033).
export function workerHealthLocalBoundary(root = ".") {
  const text = readRunbook(WORKER_HEALTH_FILE, root);
  return (
    WORKER_LOCAL_PORT.test(text) &&
    DEV_WORKER.test(text) &&
    RUNTIME_BUILD.test(text)
  );
}

// Lines mentioning production/monitoring/uptime without a deferral marker
// (VAL-GOV-033).
export function productionClaimHits(text) {
  return text
    .split("\n")
    .filter((line) => MONITORING_TERM.test(line) && !DEFERRAL_MARKER.test(line))
    .map((line) => line.trim());
}

export function secretValueHits(text) {
  return text.split("\n").filter((line) => SECRET_VALUE.test(line));
}

export function productionMutationHits(text) {
  return text.split("\n").filter((line) => PROD_MUTATION.test(line));
}

// Secret-shaped identifiers used outside the documented placeholder set
// (VAL-GOV-034).
export function unknownSecretNames(text) {
  const allowed = new Set(PLACEHOLDER_SECRETS);
  const found = new Set([...text.matchAll(SECRETY_NAME)].map((m) => m[0]));
  return [...found].filter((name) => !allowed.has(name));
}
