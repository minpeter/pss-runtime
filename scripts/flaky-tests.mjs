#!/usr/bin/env node
// test:flaky — bounded repeated-run flaky detection (VAL-SEC-025/026).
//
// Runs the deterministic repository invariant suite (scripts/*.test.mjs —
// offline, no services, no ports) through Vitest an explicit, bounded number
// of times (--runs, default 5, ceiling 20), each run bounded by a per-run
// timeout (--timeout seconds, default 300, ceiling 900), with Vitest's
// built-in retry disabled (--retry=0) so a single failing run is reported
// failed, never auto-masked. Per-test outcomes are aggregated across runs: a
// test that both passes and fails is "flaky", a test that fails every run is
// "failed", everything else is "passed". The classification report goes to
// the registered report/flaky-tests.json path (gitignored, never committed;
// CI uploads it as a bounded artifact — see .github/workflows/flaky-tests.yml)
// and the producer exits non-zero when any test classifies flaky or failed,
// or when a run fails to produce a parseable report.
//
// Usage:
//   node scripts/flaky-tests.mjs [--runs <n>] [--timeout <s>] [--out <path>]

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reportTool } from "./report-paths.mjs";

export const FLAKY_TOOL = reportTool("flaky");
export const DEFAULT_RUNS = 5;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_RUNS = 20;
export const MAX_TIMEOUT_SECONDS = 900;

const VITEST_CLI = "node_modules/vitest/vitest.mjs";
const TMP_DIR = resolve(".omo/tmp");
const SCRIPTS_DIR = "scripts";
const TEST_FILE = /\.test\.mjs$/;
const SUITE_LABEL = "scripts/*.test.mjs";
const ENTRY_STATUSES = new Set(["passed", "flaky", "failed"]);

// The repeated suite: the deterministic scripts/*.test.mjs invariants. Files
// are enumerated explicitly: a literal glob passed without a shell is a
// filter pattern, not an expansion, and can silently match nothing.
function suiteFiles() {
  const files = [];
  for (const entry of readdirSync(SCRIPTS_DIR)) {
    if (TEST_FILE.test(entry)) {
      files.push(join(SCRIPTS_DIR, entry));
    }
  }
  return files.sort();
}

// Retries are forced off at the CLI level on top of the checked-in-config
// scan (VAL-SEC-026), so even a local config drift cannot mask a failure.
export function vitestRunArgs(outputFile) {
  return [
    "run",
    ...suiteFiles(),
    "--retry=0",
    "--reporter=json",
    `--outputFile=${outputFile}`,
  ];
}

// Classification (VAL-SEC-026): both a pass and a fail across runs means
// flaky; failures with no pass mean failed; otherwise passed.
export function classifyOutcomes(outcomes) {
  const failures = outcomes.filter((outcome) => outcome === "failed").length;
  const passes = outcomes.filter((outcome) => outcome === "passed").length;
  if (failures > 0 && passes > 0) {
    return "flaky";
  }
  return failures > 0 ? "failed" : "passed";
}

// Aggregate per-run Vitest JSON reports into one entry per test. File paths
// are relativized against the working directory so the report never bakes
// in an absolute host path.
export function aggregateRunReports(reports) {
  const cwd = process.cwd();
  const outcomes = new Map();
  for (const report of reports) {
    for (const file of report?.testResults ?? []) {
      const name = String(file?.name ?? "unknown");
      const relative = name.startsWith(`${cwd}/`)
        ? name.slice(cwd.length + 1)
        : name;
      for (const assertion of file?.assertionResults ?? []) {
        const title = String(assertion?.fullName ?? assertion?.title ?? "?");
        const key = `${relative} ${title}`;
        if (!outcomes.has(key)) {
          outcomes.set(key, { file: relative, name: title, results: [] });
        }
        outcomes.get(key).results.push(String(assertion?.status ?? "unknown"));
      }
    }
  }
  return [...outcomes.values()]
    .map((entry) => ({
      file: entry.file,
      name: entry.name,
      status: classifyOutcomes(entry.results),
      runs: entry.results.length,
      failures: entry.results.filter((result) => result === "failed").length,
    }))
    .sort((a, b) => `${a.file} ${a.name}`.localeCompare(`${b.file} ${b.name}`));
}

export function buildFlakyReport(
  entries,
  { runs, timeoutSeconds, cap = FLAKY_TOOL.cap }
) {
  const truncated = entries.length > cap;
  const summary = { passed: 0, flaky: 0, failed: 0 };
  for (const entry of entries) {
    summary[entry.status] = (summary[entry.status] ?? 0) + 1;
  }
  return {
    tool: "flaky",
    suite: SUITE_LABEL,
    runs,
    timeoutSeconds,
    retry: 0,
    totalEntries: entries.length,
    summary,
    entries: truncated ? entries.slice(0, cap) : entries,
    truncated,
    ...(truncated && {
      note: `report capped at ${cap} entries (reportTool("flaky").cap in scripts/report-paths.mjs)`,
    }),
  };
}

// Artifact shape validation: numeric bounds plus one entry per test with a
// classification status (VAL-SEC-026).
export function flakyArtifactProblems(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.entries)
  ) {
    return ["artifact must be an object with an entries array"];
  }
  const problems = [];
  if (!Number.isInteger(value.runs) || value.runs < 1) {
    problems.push("artifact lacks a positive integer runs count");
  }
  if (!Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 1) {
    problems.push("artifact lacks a bounded numeric timeoutSeconds");
  }
  value.entries.forEach((entry, index) => {
    if (typeof entry?.file !== "string" || typeof entry?.name !== "string") {
      problems.push(`entries[${index}] lacks file/name strings`);
    }
    if (!ENTRY_STATUSES.has(entry?.status)) {
      problems.push(
        `entries[${index}] has an invalid status (expected passed|flaky|failed)`
      );
    }
  });
  return problems;
}

const USAGE = `Usage: node scripts/flaky-tests.mjs [--runs <n>] [--timeout <s>] [--out <path>]

Re-runs ${SUITE_LABEL} <n> times (default ${DEFAULT_RUNS}, max ${MAX_RUNS}), each run
bounded by <s> seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).
Writes the classification report (default: ${FLAKY_TOOL.path}); exits non-zero when any
test classifies flaky or failed, or a run produces no parseable report.
  --runs <n>     explicit repeat count (1..${MAX_RUNS})
  --timeout <s>  bounded per-run timeout in seconds (1..${MAX_TIMEOUT_SECONDS})
  --out <path>   report destination
  --help         print this usage and exit 0`;

function parseArgs(argv) {
  const args = {
    help: false,
    runs: DEFAULT_RUNS,
    timeout: DEFAULT_TIMEOUT_SECONDS,
    out: FLAKY_TOOL.path,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    // pnpm/npm forward the "--" separator verbatim; it is not an option.
    if (token === "--") {
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token !== "--runs" && token !== "--timeout" && token !== "--out") {
      return { error: `unknown option: ${token}` };
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return { error: `option ${token} requires a value` };
    }
    index += 1;
    if (token === "--out") {
      args.out = value;
      continue;
    }
    const max = token === "--runs" ? MAX_RUNS : MAX_TIMEOUT_SECONDS;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
      return { error: `option ${token} requires an integer in 1..${max}` };
    }
    args[token === "--runs" ? "runs" : "timeout"] = parsed;
  }
  return args;
}

function executeRuns(args) {
  const reports = [];
  let incomplete = false;
  for (let run = 1; run <= args.runs; run += 1) {
    const out = resolve(TMP_DIR, `flaky-run-${run}.vitest.json`);
    const result = spawnSync(
      process.execPath,
      [VITEST_CLI, ...vitestRunArgs(out)],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: args.timeout * 1000,
        env: { ...process.env, TMPDIR: TMP_DIR },
      }
    );
    if (result.error) {
      console.error(
        `test:flaky: run ${run}/${args.runs} hit the bounded ${args.timeout}s timeout or failed to spawn: ${result.error.message}`
      );
      incomplete = true;
      continue;
    }
    try {
      reports.push(JSON.parse(readFileSync(out, "utf8")));
    } catch (error) {
      console.error(
        `test:flaky: run ${run}/${args.runs} produced no parseable report: ${error.message}`
      );
      incomplete = true;
    }
  }
  return { reports, incomplete };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const { reports, incomplete } = executeRuns(args);
  const report = buildFlakyReport(aggregateRunReports(reports), {
    runs: args.runs,
    timeoutSeconds: args.timeout,
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  const { passed, flaky, failed } = report.summary;
  console.log(
    `test:flaky: ${args.runs} runs -> ${passed} passed, ${flaky} flaky, ${failed} failed -> ${args.out}`
  );
  for (const entry of report.entries) {
    if (entry.status !== "passed") {
      console.error(
        `test:flaky: ${entry.status}: ${entry.file} > ${entry.name} (${entry.failures}/${entry.runs} runs failed)`
      );
    }
  }
  if (reports.length === 0) {
    console.error("test:flaky: no completed runs; refusing to report");
    return 1;
  }
  return flaky > 0 || failed > 0 || incomplete ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
