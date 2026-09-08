import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Required-governance-files manifest (VAL-GOV-060). Every entry must exist on
// disk and stay git-tracked, so a deletion regression (for example removing
// the CODEOWNERS file) fails `pnpm test` instead of passing silently.
export const REQUIRED_MANIFEST = [
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "docs/deferred-controls.md",
  "docs/label-taxonomy.md",
  "docs/runbooks/README.md",
  "docs/runbooks/ci-failure-triage.md",
  "docs/runbooks/extended-verification.md",
  "docs/runbooks/release-procedure.md",
  "docs/runbooks/security-scan-failure-triage.md",
  "docs/runbooks/worker-health.md",
  "docs/runbooks/worker-privacy-retention.md",
  ".factory/skills/edge-contract-check/SKILL.md",
  ".factory/skills/repo-guardian/SKILL.md",
];

// Extra governance/agent-context files covered by the credential and
// host-path scans (VAL-GOV-062/063) that are not part of the manifest.
export const SCAN_EXTRA_FILES = ["AGENTS.md"];

// Directories walked recursively for the scans and the manifest drift check.
export const SCAN_DIRS = [
  ".github/ISSUE_TEMPLATE",
  "docs/runbooks",
  ".factory/skills",
];

// Credential-shaped literals that must never appear in governance or
// agent-context files (VAL-GOV-062). Documented placeholder secret NAMES
// (for example a bot-token variable name with no value) stay allowed.
export const CREDENTIAL_PATTERNS = [
  ["npm access token reference", /\bNPM_TOKEN\b/],
  ["provider API key", /\bsk-[A-Za-z0-9]{16,}/],
  [
    "GitHub token",
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
  ],
  ["JWT blob", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/],
  ["Telegram bot token value", /\b\d{8,10}:[A-Za-z0-9_-]{30,}/],
  ["chat-platform bot token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  [
    "raw env credential export",
    /^export\s+[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*["']?[^\s"']{8,}/,
  ],
];

// Absolute host paths are forbidden in governance docs (VAL-GOV-063).
export const HOST_PATH_PATTERN = /\/(?:home|Users|mnt)\//;

// Lightweight YAML parser packages: the governance tooling budget allows at
// most one in root devDependencies and no other governance-only dependency
// (VAL-GOV-059).
export const YAML_PARSERS = new Set([
  "yaml",
  "js-yaml",
  "yaml-ast-parser",
  "yamljs",
  "@stoplight/yaml",
]);

// Network/service/port APIs the offline validator itself must never use
// (VAL-GOV-061); validated by scanning this module's own source. Patterns are
// assembled from fragments so the literal tokens never appear in this file.
const FORBIDDEN_SELF_PATTERNS = [
  new RegExp(
    `node:(?:${["net", "http", "https", "http2", "dgram", "tls", "dns"].join("|")})`
  ),
  new RegExp(`\\bWeb${"Socket"}\\b`),
  new RegExp(`create${"Server"}`),
  new RegExp(`\\.lis${"ten"}\\s*\\(`),
  new RegExp(`\\bfet${"ch"}\\s*\\(`),
];

export function readDoc(path, root = ".") {
  return readFileSync(join(root, path), "utf8");
}

// Manifest entries missing from the working tree (VAL-GOV-060).
export function manifestProblems(entries, root = ".") {
  return entries
    .filter((path) => !existsSync(join(root, path)))
    .map((path) => `missing required governance file: ${path}`);
}

// Manifest entries absent from git's tracked-file list (VAL-GOV-060): a
// file that only exists locally is invisible on a clean checkout.
export function untrackedProblems(entries, trackedFiles) {
  const tracked = new Set(trackedFiles);
  return entries
    .filter((path) => !tracked.has(path))
    .map((path) => `required governance file not git-tracked: ${path}`);
}

// Full governance/agent-context scan set: manifest + extras + everything
// under the scanned directories (VAL-GOV-062/063).
export function governanceScanFiles(root = ".") {
  const files = new Set([...REQUIRED_MANIFEST, ...SCAN_EXTRA_FILES]);
  for (const dir of SCAN_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) {
      continue;
    }
    for (const entry of readdirSync(base, { recursive: true }).sort()) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(root, rel)).isFile()) {
        files.add(rel);
      }
    }
  }
  return [...files].sort();
}

// On-disk governance files the manifest does not cover: adding a new
// governance artifact without extending the manifest is drift (VAL-GOV-060).
export function manifestDriftProblems(root = ".") {
  const covered = new Set([...REQUIRED_MANIFEST, ...SCAN_EXTRA_FILES]);
  return governanceScanFiles(root)
    .filter((path) => !covered.has(path))
    .map((path) => `governance file missing from required manifest: ${path}`);
}

// "line N: kind" hits for credential-shaped literals in one text.
export function credentialHits(text) {
  const hits = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const [kind, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) {
        hits.push(`line ${index + 1}: ${kind}`);
      }
    }
  }
  return hits;
}

// "path: line N: kind" hits across the governance scan set (VAL-GOV-062).
export function repoCredentialHits(root = ".") {
  return governanceScanFiles(root).flatMap((path) =>
    credentialHits(readDoc(path, root)).map((hit) => `${path}: ${hit}`)
  );
}

export function hostPathHits(text) {
  return text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => HOST_PATH_PATTERN.test(line))
    .map(({ index }) => `line ${index + 1}: absolute host path`);
}

// "path: line N: ..." hits across the governance scan set (VAL-GOV-063).
export function repoHostPathHits(root = ".") {
  return governanceScanFiles(root).flatMap((path) =>
    hostPathHits(readDoc(path, root)).map((hit) => `${path}: ${hit}`)
  );
}

// YAML parsers present in the given dependency-name list (VAL-GOV-059).
export function yamlParsersIn(depNames) {
  return depNames.filter((name) => YAML_PARSERS.has(name));
}

// The tooling budget allows at most one lightweight YAML parser.
export function yamlScopeProblems(depNames) {
  const found = yamlParsersIn(depNames);
  return found.length > 1
    ? [`more than one YAML parser in root devDependencies: ${found.join(", ")}`]
    : [];
}

export function rootDevDependencyNames(root = ".") {
  const pkg = JSON.parse(readDoc("package.json", root));
  return Object.keys(pkg.devDependencies ?? {});
}

export function rootTestScript(root = ".") {
  const pkg = JSON.parse(readDoc("package.json", root));
  return String(pkg.scripts?.test ?? "");
}

// Offline/self-audit (VAL-GOV-061): this module's own source must not use
// network, service, or port APIs; validation is pure file reading.
export function selfNetworkHits(root = ".") {
  const source = readDoc("scripts/governance-invariants.mjs", root);
  return FORBIDDEN_SELF_PATTERNS.filter((pattern) => pattern.test(source)).map(
    (pattern) => `validator self-scan hit: ${pattern}`
  );
}
