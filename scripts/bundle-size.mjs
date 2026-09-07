import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Shared bundle-budget helpers (VAL-SEC-015..019). Pure and static: no
// network, no ports, no writes, no clock. The executable wrapper lives in
// scripts/check-bundle-size.mjs; the wrapper behavior tests live in
// scripts/check-bundle-size.test.mjs.
//
// The committed baseline (scripts/bundle-size-baseline.json) maps each
// reviewed dist/ artifact of the two published packages — packages/runtime
// and apps/coding-agent — to an explicit numeric byte ceiling recorded from
// a reference build. The set covers every published `exports` entry of both
// manifests plus the CLI entry (apps/coding-agent/dist/cli.js, loaded by
// bin/pss.js). No baseline is implicit, wildcarded, or a runtime-computed
// percentage: each entry is a concrete repo-relative path and an integer.
//
// Tolerance: a measured size fails the gate only when it exceeds
// ceil(baseline * (1 + tolerancePercent / 100)). The tolerance (5%) absorbs
// toolchain-noise drift between reference builds; a real regression larger
// than the tolerance reports artifact, measured, baseline, and delta.
// Refresh the baseline only from a reviewed reference build
// (--write-baseline) and review the diff before committing.

export const BUNDLE_BASELINE_PATH = "scripts/bundle-size-baseline.json";
export const DEFAULT_TOLERANCE_PERCENT = 5;

// Baseline artifact keys must be concrete repo-relative paths: no glob
// metacharacters, no parent traversal, no absolute paths, POSIX separators.
const WILDCARD_PATTERN = /[*?[{]/;

function artifactPathProblems(path) {
  const problems = [];
  if (typeof path !== "string" || path.length === 0) {
    problems.push("artifact keys must be non-empty path strings");
    return problems;
  }
  if (WILDCARD_PATTERN.test(path)) {
    problems.push(`artifact path must be concrete (no wildcards): ${path}`);
  }
  if (path.includes("\\")) {
    problems.push(`artifact path must use POSIX separators: ${path}`);
  }
  if (path.startsWith("/") || path.split("/").includes("..")) {
    problems.push(`artifact path must be repo-relative: ${path}`);
  }
  return problems;
}

export function baselineProblems(config) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return ["baseline must be an object"];
  }
  const problems = [];
  if (config.version !== 1) {
    problems.push("baseline must declare version: 1");
  }
  if (
    typeof config.tolerancePercent !== "number" ||
    !Number.isInteger(config.tolerancePercent) ||
    config.tolerancePercent < 0 ||
    config.tolerancePercent > 100
  ) {
    problems.push("tolerancePercent must be an integer between 0 and 100");
  }
  const artifacts = config.artifacts;
  if (
    typeof artifacts !== "object" ||
    artifacts === null ||
    Array.isArray(artifacts) ||
    Object.keys(artifacts).length === 0
  ) {
    problems.push("artifacts must be a non-empty path-to-bytes object");
    return problems;
  }
  const keys = Object.keys(artifacts);
  const sorted = [...keys].sort();
  for (const [index, path] of keys.entries()) {
    problems.push(...artifactPathProblems(path));
    const bytes = artifacts[path];
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) {
      problems.push(
        `baseline for ${path} must be an explicit positive integer byte ceiling`
      );
    }
    if (path !== sorted[index]) {
      problems.push("baseline artifact keys are not sorted");
    }
  }
  return problems;
}

// Size ceiling a measured artifact may reach before the gate fails.
export function allowedBytes(baseline, tolerancePercent) {
  return Math.ceil(baseline * (1 + tolerancePercent / 100));
}

// Measure every declared artifact under root. A missing or non-file
// artifact is never reported as zero bytes: it lands in `missing` with the
// expected path so the caller can fail the run.
export function measureArtifacts(root, paths) {
  const measured = new Map();
  const missing = [];
  for (const path of paths) {
    const full = join(root, path);
    if (!(existsSync(full) && statSync(full).isFile())) {
      missing.push(path);
      continue;
    }
    measured.set(path, statSync(full).size);
  }
  return { measured, missing };
}

export function evaluateBudget(config, measured) {
  const tolerance = config.tolerancePercent;
  const rows = [];
  for (const [path, baseline] of Object.entries(config.artifacts)) {
    if (!measured.has(path)) {
      continue;
    }
    const size = measured.get(path);
    const allowed = allowedBytes(baseline, tolerance);
    rows.push({
      path,
      measured: size,
      baseline,
      delta: size - baseline,
      allowed,
      tolerancePercent: tolerance,
      ok: size <= allowed,
    });
  }
  return rows;
}

export function overLine(row) {
  const sign = row.delta >= 0 ? "+" : "";
  return (
    `OVER ${row.path}: measured=${row.measured} baseline=${row.baseline} ` +
    `delta=${sign}${row.delta} allowed=${row.allowed} ` +
    `(tolerance ${row.tolerancePercent}%)`
  );
}
