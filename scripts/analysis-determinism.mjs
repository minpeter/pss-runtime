// Determinism invariants for the analysis/security checks added by this
// mission (VAL-SEC-043): Knip, jscpd, workspace drift, bundle budget, Worker
// coverage, test timing, and flaky detection. Two consecutive runs on the
// same tree under PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1 must produce
// identical exit codes and identical report content, with no network egress.
//
// This module holds the static scans (no clock, no randomness, no network in
// the report-producing sources; sorted directory enumeration) plus the
// canonical comparison helpers used to prove report equivalence. The full
// twice-run evidence per check is captured under .omo/evidence/ by the
// feature that owns it; the focused test double-runs the pure drift check
// and the report normalizers.

// The new checks and the sources that produce their results/reports.
// `report` is the id in scripts/report-paths.mjs when the check writes a
// bounded report; Worker coverage writes its own gitignored coverage
// directory instead (asserted by scripts/worker-coverage.test.mjs).
export const ANALYSIS_CHECKS = [
  {
    id: "knip",
    sources: ["scripts/knip-unused.mjs", "scripts/check-unused.mjs"],
    report: "knip",
  },
  {
    id: "jscpd",
    sources: ["scripts/jscpd-duplicates.mjs", "scripts/check-duplicates.mjs"],
    report: "jscpd",
  },
  {
    id: "drift",
    sources: [
      "scripts/workspace-version-drift.mjs",
      "scripts/check-workspace-version-drift.mjs",
    ],
    report: "drift",
  },
  {
    id: "bundle-budget",
    sources: ["scripts/bundle-size.mjs", "scripts/check-bundle-size.mjs"],
    report: "bundle-budget",
  },
  {
    id: "worker-coverage",
    sources: ["apps/worker-agent/vitest.config.ts"],
    report: null,
  },
  {
    id: "test-timing",
    sources: ["scripts/test-timing.mjs"],
    report: "test-timing",
  },
  { id: "flaky", sources: ["scripts/flaky-tests.mjs"], report: "flaky" },
];

// A deterministic, offline report producer never reads the wall clock, never
// samples randomness, and never touches the network. Subprocess spawns of
// the local tool binaries and writes to gitignored report paths are the
// designed behavior and are not flagged here.
const NONDETERMINISM_PATTERNS = [
  [/\bDate\.now\s*\(/, "reads wall-clock time (Date.now)"],
  [/\bnew Date\s*\(/, "reads wall-clock time (new Date)"],
  [/\bperformance\.now\s*\(/, "reads wall-clock time (performance.now)"],
  [/\bMath\.random\s*\(/, "samples Math.random"],
  [/\bnode:(?:http|https|http2|net|dgram|dns)\b/, "imports a network module"],
  [/(?<![\w$.])fetch\s*\(/, "calls fetch"],
  [/\bWebSocket\b|\bXMLHttpRequest\b/, "uses a network client"],
];

export function nondeterminismProblems(label, source) {
  return NONDETERMINISM_PATTERNS.filter(([pattern]) =>
    pattern.test(source)
  ).map(([, reason]) => `${label} ${reason}`);
}

// readdirSync returns filesystem order; any producer enumerating a directory
// must sort the listing so report content cannot depend on inode order.
const READDIR_CALL = /\breaddirSync\s*\(/;
const SORT_CALL = /\.sort\s*\(/;

export function enumerationProblems(label, source) {
  if (READDIR_CALL.test(source) && !SORT_CALL.test(source)) {
    return [`${label} enumerates a directory without sorting`];
  }
  return [];
}

// Canonical JSON: object keys sorted recursively, so two runs of the same
// check compare equal even if a producer's key insertion order drifted.
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reportsEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// test:timing durations are measurements, not findings: the deterministic
// content of the timing report is the executed-test set, statuses, and
// counts. This comparison key keeps that content and zeroes the durations so
// two runs on the same tree compare equal.
export function timingComparisonKey(report) {
  const entries = [...(report?.entries ?? [])]
    .map((entry) => ({ ...entry, duration: 0 }))
    .sort((a, b) => `${a.file} ${a.name}`.localeCompare(`${b.file} ${b.name}`));
  return stableStringify({ ...report, entries });
}
