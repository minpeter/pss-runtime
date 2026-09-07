import { readFileSync } from "node:fs";
import { LOCKFILE_TOKENS, REQUIRED_IGNORE_TOKENS } from "./knip-unused.mjs";
import { reportTool } from "./report-paths.mjs";

// Shared jscpd duplicate-code check helpers (VAL-SEC-002..007 for the jscpd
// leg). Pure and static: no network, no ports, no writes, no clock. The
// executable wrapper lives in scripts/check-duplicates.mjs; the invariants
// live in scripts/jscpd-duplicates.test.mjs. Baseline validation, signature
// diffing, the report cap, and CODEOWNERS coverage are shared with the Knip
// gate: consumers import those straight from scripts/knip-unused.mjs.

export const JSCPD_CONFIG_PATH = ".jscpd.json";
export const JSCPD_BASELINE_PATH = "scripts/jscpd-baseline.json";
// Report destination comes from the canonical registry
// (scripts/report-paths.mjs, VAL-SEC-008); the entry cap is the shared
// REPORT_ENTRY_CAP exported by scripts/knip-unused.mjs.
export const JSCPD_REPORT_PATH = reportTool("jscpd").path;
export const JSCPD_RAW_REPORT_NAME = "jscpd-report.json";

// experimental/ and examples/ stay analyzed; their accepted duplicate
// boilerplate is suppressed through named, path-scoped allowlist entries
// (VAL-SEC-006), each strictly narrower than the scope itself.
export const ALLOWLIST_SCOPES = ["examples/", "experimental/"];

const BARE_WILDCARDS = new Set(["*", "**", "**/*", "**/**", "*/**"]);
const KEBAB_NAME = /^[a-z0-9-]+$/;
const MIN_JUSTIFICATION_LENGTH = 12;

export function readJscpdConfig(path = JSCPD_CONFIG_PATH) {
  // .jscpd.json is strict JSON (no comments): allowlist justifications are
  // structured entry fields, not comment markers (VAL-SEC-007).
  return JSON.parse(readFileSync(path, "utf8"));
}

// Positive thresholds keep the tool from emitting an unbounded duplicate
// report (VAL-SEC-007).
export function thresholdProblems(config) {
  const problems = [];
  for (const key of ["minTokens", "minLines"]) {
    const value = config?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      problems.push(`jscpd config "${key}" must be a number greater than zero`);
    }
  }
  return problems;
}

function ignorePatterns(config) {
  return Array.isArray(config?.ignore)
    ? config.ignore.filter((pattern) => typeof pattern === "string")
    : [];
}

export function allowlistEntries(config) {
  return Array.isArray(config?.allowlist) ? config.allowlist : [];
}

// Generated and third-party paths must stay out of analysis so reports are
// source-only and cannot flag committed or built artifacts (VAL-SEC-003).
export function ignoreCoverageProblems(config) {
  const patterns = ignorePatterns(config);
  const problems = REQUIRED_IGNORE_TOKENS.filter(
    (token) => !patterns.some((pattern) => pattern.includes(token))
  ).map(
    (token) =>
      `jscpd ignore list lacks a generated-path exclusion for "${token}"`
  );
  const hasLockfile = LOCKFILE_TOKENS.some((token) =>
    patterns.some((pattern) => pattern.includes(token))
  );
  if (!hasLockfile) {
    problems.push("jscpd ignore list lacks a lockfile exclusion");
  }
  return problems;
}

export function bareWildcardProblems(config) {
  const patterns = [
    ...ignorePatterns(config),
    ...allowlistEntries(config).map((entry) => entry?.path),
  ].filter((pattern) => typeof pattern === "string");
  return patterns
    .filter((pattern) => BARE_WILDCARDS.has(pattern))
    .map(
      (pattern) =>
        `bare-wildcard suppression "${pattern}" is not allowed; use a named, path-scoped pattern`
    );
}

// Every allowlist entry is explicit, named, scoped, and justified so
// additions are reviewable (VAL-SEC-005).
export function allowlistEntryProblems(config) {
  const problems = [];
  const names = new Set();
  allowlistEntries(config).forEach((entry, index) => {
    const label = `allowlist[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${label} must be an object with name/path/justification`);
      return;
    }
    if (typeof entry.name !== "string" || !KEBAB_NAME.test(entry.name)) {
      problems.push(`${label} needs a kebab-case "name"`);
    } else if (names.has(entry.name)) {
      problems.push(`duplicate allowlist name "${entry.name}"`);
    }
    names.add(entry.name);
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      problems.push(`${label} needs a non-empty path-scoped "path"`);
    }
    if (
      typeof entry.justification !== "string" ||
      entry.justification.trim().length < MIN_JUSTIFICATION_LENGTH
    ) {
      problems.push(`${label} justification is missing or too thin to review`);
    }
  });
  return problems;
}

function isWholeScopePattern(scope, path) {
  return path === scope || path === `${scope}**` || path === `${scope}**/*`;
}

// examples/ and experimental/ must each carry at least one path-scoped
// allowlist entry narrower than the scope itself — suppressing the whole
// scope would be a global disable, not an allowlist (VAL-SEC-006).
export function scopedAllowlistProblems(config) {
  const problems = [];
  const entries = allowlistEntries(config);
  for (const scope of ALLOWLIST_SCOPES) {
    const scoped = entries.filter(
      (entry) => typeof entry?.path === "string" && entry.path.startsWith(scope)
    );
    if (scoped.length === 0) {
      problems.push(
        `jscpd config has no path-scoped allowlist entry under "${scope}"`
      );
      continue;
    }
    for (const entry of scoped) {
      if (isWholeScopePattern(scope, entry.path)) {
        problems.push(
          `allowlist entry "${entry.name}" suppresses the whole "${entry.path}" scope (global disable)`
        );
      }
    }
  }
  return problems;
}

// The wrapper merges configured ignores with allowlist paths into one CLI
// --ignore list: a CLI --ignore overrides the config list in jscpd, so the
// merge must happen here.
export function ignorePatternsForRun(config) {
  return [
    ...ignorePatterns(config),
    ...allowlistEntries(config)
      .map((entry) => entry?.path)
      .filter((path) => typeof path === "string"),
  ];
}

// A duplicate signature is a fingerprint of the clone block: both file+range
// endpoints, lexicographically ordered so the pair is stable regardless of
// which side jscpd reports first — never a numeric count (VAL-SEC-002).
export function signatureForDuplicate(duplicate) {
  const endpoint = (file) => `${file?.name}:${file?.start}-${file?.end}`;
  const pair = [
    endpoint(duplicate?.firstFile),
    endpoint(duplicate?.secondFile),
  ].sort();
  return `duplicates:${pair[0]}=${pair[1]}`;
}

export function signaturesFromReport(report) {
  const signatures = new Set();
  for (const duplicate of report?.duplicates ?? []) {
    signatures.add(signatureForDuplicate(duplicate));
  }
  return [...signatures].sort();
}
