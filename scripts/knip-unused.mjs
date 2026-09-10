import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { normalizePattern, parseCodeowners } from "./governance-codeowners.mjs";
import { parseJsonc } from "./jsonc.mjs";
import { reportTool } from "./report-paths.mjs";

// Shared Knip unused-code check helpers (VAL-SEC-001..006). Pure and static:
// no network, no ports, no writes, no clock. The executable wrapper lives in
// scripts/check-unused.mjs; the invariants live in scripts/knip-unused.test.mjs.

export const KNIP_CONFIG_PATH = "knip.jsonc";
export const KNIP_BASELINE_PATH = "scripts/knip-baseline.json";
// Report destination and entry cap come from the canonical registry
// (scripts/report-paths.mjs, VAL-SEC-008/009): a noisy run truncates at this
// many signature entries and notes the truncation, so a report can never
// exhaust CI storage.
export const KNIP_REPORT_PATH = reportTool("knip").path;
export const WORKSPACE_MANIFEST_PATH = "pnpm-workspace.yaml";
export const CODEOWNERS_PATH = ".github/CODEOWNERS";

export const REPORT_ENTRY_CAP = reportTool("knip").cap;

// Generated and third-party paths that must stay out of analysis (VAL-SEC-003).
export const REQUIRED_IGNORE_TOKENS = [
  "dist",
  "node_modules",
  ".wrangler",
  ".turbo",
  "coverage",
  "experimental/nextjs-bench/results",
];
export const LOCKFILE_TOKENS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

// experimental/ and examples/ stay analyzed; their known false positives are
// suppressed through named, path-scoped allowlist entries (VAL-SEC-006).
export const ALLOWLIST_SCOPES = ["examples/*", "experimental/*"];

const BARE_WILDCARDS = new Set(["*", "**", "**/*", "**/**", "*/**"]);
const SIGNATURE_PATTERN = /^[a-zA-Z]+:[^#\s]+(#\S.*)?$/;
const ALLOWLIST_MARKER = /^\/\/\s*allowlist\[([a-z0-9-]+)\]:\s*(.+)$/;
const MIN_JUSTIFICATION_LENGTH = 12;

export function readKnipConfig(path = KNIP_CONFIG_PATH) {
  return parseJsonc(readFileSync(path, "utf8"));
}

// A finding signature is `<issue-type>:<file>` for file-scoped findings and
// `<issue-type>:<file>#<symbol>` otherwise — never a numeric count.
export function signatureFor(type, file, name) {
  return type === "files" || name === undefined
    ? `${type}:${file}`
    : `${type}:${file}#${name}`;
}

function rowSignatures(row) {
  const signatures = [];
  for (const [type, items] of Object.entries(row)) {
    if (type === "file" || type === "owners" || !Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (type === "duplicates" || type === "cycles") {
        const names = (Array.isArray(item) ? item : [item]).map(
          (entry) => entry?.name ?? "?"
        );
        signatures.push(signatureFor(type, row.file, names.join(",")));
      } else {
        signatures.push(signatureFor(type, row.file, item?.name));
      }
    }
  }
  return signatures;
}

export function signaturesFromReport(report) {
  const signatures = new Set();
  for (const row of report?.issues ?? []) {
    for (const signature of rowSignatures(row)) {
      signatures.add(signature);
    }
  }
  return [...signatures].sort();
}

export function baselineProblems(baseline) {
  if (baseline?.version !== 1 || !Array.isArray(baseline?.signatures)) {
    return ["baseline must be { version: 1, signatures: string[] }"];
  }
  const problems = [];
  const seen = new Set();
  baseline.signatures.forEach((signature, index) => {
    if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
      problems.push(
        `signature[${index}] is not a valid file+symbol signature: ${JSON.stringify(signature)}`
      );
      return;
    }
    if (seen.has(signature)) {
      problems.push(`duplicate baseline signature: ${signature}`);
    }
    seen.add(signature);
  });
  const sorted = [...baseline.signatures].sort();
  if (
    baseline.signatures.some((signature, index) => signature !== sorted[index])
  ) {
    problems.push("baseline signatures are not sorted");
  }
  return problems;
}

export function diffSignatures(findings, baselineSignatures) {
  const current = new Set(findings);
  const accepted = new Set(baselineSignatures);
  return {
    newSignatures: findings.filter((signature) => !accepted.has(signature)),
    staleSignatures: baselineSignatures.filter(
      (signature) => !current.has(signature)
    ),
  };
}

export function workspaceGlobs(manifestPath = WORKSPACE_MANIFEST_PATH) {
  return parseYaml(readFileSync(manifestPath, "utf8"))?.packages ?? [];
}

// Every knip workspace entry pattern must be one of the pnpm-workspace.yaml
// globs, so analysis scope can never drift wider than the workspace itself.
export function workspaceScopeProblems(config, globs) {
  const allowed = new Set(globs);
  return Object.keys(config?.workspaces ?? {})
    .filter((key) => key !== "." && !allowed.has(key))
    .map(
      (key) =>
        `knip workspace "${key}" is not one of the pnpm-workspace.yaml globs`
    );
}

export function ignoreCoverageProblems(config) {
  const patterns = Array.isArray(config?.ignore) ? config.ignore : [];
  const problems = REQUIRED_IGNORE_TOKENS.filter(
    (token) => !patterns.some((p) => typeof p === "string" && p.includes(token))
  ).map(
    (token) =>
      `knip ignore list lacks a generated-path exclusion for "${token}"`
  );
  const hasLockfile = LOCKFILE_TOKENS.some((token) =>
    patterns.some((p) => typeof p === "string" && p.includes(token))
  );
  if (!hasLockfile) {
    problems.push("knip ignore list lacks a lockfile exclusion");
  }
  return problems;
}

function allIgnorePatterns(config) {
  const patterns = Array.isArray(config?.ignore) ? [...config.ignore] : [];
  for (const workspace of Object.values(config?.workspaces ?? {})) {
    if (Array.isArray(workspace?.ignore)) {
      patterns.push(...workspace.ignore);
    }
  }
  return patterns.filter((p) => typeof p === "string");
}

export function bareWildcardProblems(config) {
  return allIgnorePatterns(config)
    .filter((pattern) => BARE_WILDCARDS.has(pattern))
    .map(
      (pattern) =>
        `bare-wildcard suppression "${pattern}" is not allowed; use a named, path-scoped pattern`
    );
}

// Every suppression scope (a workspace block carrying `ignore`) needs an
// adjacent `// allowlist[<kebab-name>]: <justification>` comment so additions
// are named, justified, and reviewable (VAL-SEC-005).
export function allowlistMarkerProblems(source, config) {
  const problems = [];
  const lines = source.split("\n");
  const scopes = Object.entries(config?.workspaces ?? {})
    .filter(([key, value]) => key !== "." && (value?.ignore?.length ?? 0) > 0)
    .map(([key]) => key);
  const names = new Set();
  for (const key of scopes) {
    const index = lines.findIndex((line) => line.includes(`"${key}"`));
    let marker = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const text = lines[cursor].trim();
      if (text === "") {
        continue;
      }
      if (!text.startsWith("//")) {
        break;
      }
      const match = ALLOWLIST_MARKER.exec(text);
      if (match) {
        marker = { name: match[1], justification: match[2].trim() };
        break;
      }
    }
    if (!marker) {
      problems.push(
        `suppression scope "${key}" has no allowlist[name]: justification comment`
      );
      continue;
    }
    if (marker.justification.length < MIN_JUSTIFICATION_LENGTH) {
      problems.push(
        `allowlist[${marker.name}] justification is too thin to review`
      );
    }
    if (names.has(marker.name)) {
      problems.push(`duplicate allowlist name "${marker.name}"`);
    }
    names.add(marker.name);
  }
  return problems;
}

// experimental/ and examples/ must have path-scoped allowlist entries that
// suppress named patterns only — never a global disable of the analysis.
export function scopedAllowlistProblems(config) {
  const problems = [];
  for (const scope of ALLOWLIST_SCOPES) {
    const entry = config?.workspaces?.[scope];
    if (!entry) {
      problems.push(
        `knip config has no path-scoped allowlist entry for "${scope}"`
      );
      continue;
    }
    const patterns = Array.isArray(entry.ignore) ? entry.ignore : [];
    if (patterns.length === 0) {
      problems.push(`allowlist entry "${scope}" names no scoped pattern`);
    }
    if (
      entry.rules &&
      Object.values(entry.rules).every((value) => value === "off")
    ) {
      problems.push(
        `allowlist entry "${scope}" disables every issue type (global disable)`
      );
    }
  }
  return problems;
}

function patternCoversPath(pattern, path) {
  const normalized = normalizePattern(pattern);
  if (normalized === "*") {
    return true;
  }
  return (
    normalized === path ||
    path.startsWith(`${normalized}/`) ||
    normalized.startsWith(`${path}/`)
  );
}

// Tool config and baseline paths must be CODEOWNERS-covered so allowlist or
// baseline additions route to a reviewer (VAL-SEC-005).
export function codeownersCoverageProblems(codeownersSource, paths) {
  const { entries } = parseCodeowners(codeownersSource);
  return paths
    .filter(
      (path) => !entries.some(({ pattern }) => patternCoversPath(pattern, path))
    )
    .map((path) => `${path} is not covered by any .github/CODEOWNERS pattern`);
}
