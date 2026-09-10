#!/usr/bin/env node
// test:timing — machine-readable test-timing producer (VAL-SEC-024).
//
// Runs the repository invariant suite (scripts/*.test.mjs — deterministic,
// offline, no services, no ports) through the Vitest JSON reporter and
// normalizes the result into report/test-timing.json: one entry per executed
// test with a numeric `duration` field, capped at the registry cap in
// scripts/report-paths.mjs (ci: "artifact"). The artifact path is gitignored
// and travels to CI only as a bounded upload-artifact step (see ci.yml); it
// is never committed.
//
// Usage:
//   node scripts/test-timing.mjs [--out <path>]   (default: the registry path)
//
// The producer fails loudly: an unparseable Vitest report or a zero-entry
// artifact exits non-zero instead of emitting an empty or malformed file.
// A failing Vitest run still writes the artifact for triage, then
// propagates the failure exit code.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_ARTIFACT_RETENTION_DAYS,
  uploadPathCovers,
} from "./report-hygiene.mjs";
import { reportTool } from "./report-paths.mjs";
import { parseWorkflowDocs } from "./workflow-docs.mjs";

export const TIMING_TOOL = reportTool("test-timing");

// Vitest CLI entry (pnpm links node_modules/vitest/vitest.mjs) and the raw
// reporter output, kept under the gitignored agent workspace.
const VITEST_CLI = "node_modules/vitest/vitest.mjs";
const TMP_DIR = resolve(".omo/tmp");

// The timed suite: the deterministic scripts/*.test.mjs invariants. They are
// offline and fast, so the producer is safe for the fast CI gate. The files
// are enumerated explicitly: a literal glob passed without a shell is a
// filter pattern, not an expansion, and can silently match nothing.
const TIMED_SUITE = "scripts/*.test.mjs";
const SCRIPTS_DIR = "scripts";
const TEST_FILE = /\.test\.mjs$/;

function suiteFiles() {
  return readdirSync(SCRIPTS_DIR)
    .filter((file) => TEST_FILE.test(file))
    .sort()
    .map((file) => `${SCRIPTS_DIR}/${file}`);
}

function vitestArgs(rawReport) {
  return [
    "run",
    ...suiteFiles(),
    "--reporter=json",
    `--outputFile=${rawReport}`,
  ];
}

// Normalize a Vitest JSON report into the timing artifact shape: one entry
// per executed test with a numeric `duration`. A skipped/pending test has no
// reporter duration; it is coerced to 0 so every entry carries the field.
// File paths are relativized against the working directory so the artifact
// never bakes in an absolute host path.
export function normalizeTiming(vitestJson, cap = TIMING_TOOL.cap) {
  const cwd = process.cwd();
  const entries = [];
  for (const file of vitestJson?.testResults ?? []) {
    const fileName = String(file?.name ?? "unknown");
    for (const assertion of file?.assertionResults ?? []) {
      const raw = assertion?.duration;
      entries.push({
        file: fileName.startsWith(`${cwd}/`)
          ? fileName.slice(cwd.length + 1)
          : fileName,
        name: String(assertion?.fullName ?? assertion?.title ?? "unknown"),
        status: String(assertion?.status ?? "unknown"),
        duration:
          typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0,
      });
    }
  }
  const truncated = entries.length > cap;
  return {
    tool: "test-timing",
    suite: TIMED_SUITE,
    totalEntries: entries.length,
    entries: truncated ? entries.slice(0, cap) : entries,
    truncated,
    ...(truncated && {
      note: `report capped at ${cap} entries (reportTool("test-timing").cap in scripts/report-paths.mjs)`,
    }),
  };
}

// Artifact shape validation: a parseable object with an entries array where
// every entry carries a non-negative numeric duration (VAL-SEC-024).
export function timingArtifactProblems(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.entries)
  ) {
    return ["artifact must be an object with an entries array"];
  }
  const problems = [];
  value.entries.forEach((entry, index) => {
    if (
      typeof entry?.duration !== "number" ||
      !Number.isFinite(entry.duration) ||
      entry.duration < 0
    ) {
      problems.push(`entries[${index}] lacks a numeric duration`);
    }
  });
  return problems;
}

const PRODUCER_RUN = /(^|\s)(pnpm\s+(run\s+)?)?test:timing(\s|$)/;
const UPLOAD_ARTIFACT = /^actions\/upload-artifact[@/]/;

function boundedRetention(step) {
  const retention = step?.with?.["retention-days"];
  return (
    typeof retention === "number" &&
    Number.isInteger(retention) &&
    retention >= 1 &&
    retention <= MAX_ARTIFACT_RETENTION_DAYS
  );
}

function isProducerStep(step) {
  return typeof step?.run === "string" && PRODUCER_RUN.test(step.run);
}

// True when the step is an upload-artifact step covering the timing artifact
// with bounded retention; an unbounded covering step is a named problem.
function isBoundedUploadStep(step, tool, label, problems) {
  if (typeof step?.uses !== "string" || !UPLOAD_ARTIFACT.test(step.uses)) {
    return false;
  }
  const tokens = String(step?.with?.path ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (!tokens.some((token) => uploadPathCovers(token, tool.path))) {
    return false;
  }
  if (boundedRetention(step)) {
    return true;
  }
  problems.push(
    `${label}: the upload-artifact step for ${tool.path} lacks a bounded retention-days (1..${MAX_ARTIFACT_RETENTION_DAYS})`
  );
  return false;
}

// CI wiring: some workflow step produces the artifact via `test:timing` and
// a bounded upload-artifact step uploads the registered path (VAL-SEC-024).
export function timingCiProblems(workflows, tool = TIMING_TOOL) {
  const problems = [];
  let produced = false;
  let uploaded = false;
  for (const { path, doc } of parseWorkflowDocs(workflows, problems)) {
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const [index, step] of (job?.steps ?? []).entries()) {
        const label = `${path} job "${jobName}" step ${index + 1}`;
        produced = produced || isProducerStep(step);
        uploaded = isBoundedUploadStep(step, tool, label, problems) || uploaded;
      }
    }
  }
  if (!produced) {
    problems.push(
      "no workflow step runs the test:timing producing step for the timing artifact"
    );
  }
  if (!uploaded) {
    problems.push(`no bounded upload-artifact step uploads ${tool.path}`);
  }
  return problems;
}

const USAGE = `Usage: node scripts/test-timing.mjs [--out <path>]

Runs ${TIMED_SUITE} through the Vitest JSON reporter and writes the
normalized timing artifact (one entry per test with a numeric duration).

Options:
  --out <path>   artifact destination (default: ${TIMING_TOOL.path})
  --help         print this usage and exit 0`;

function parseArgs(argv) {
  const args = { help: false, out: TIMING_TOOL.path };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--out") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "option --out requires a value" };
      }
      args.out = value;
      index += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const rawDir = mkdtempSync(resolve(TMP_DIR, "test-timing-"));
  const rawReport = resolve(rawDir, "vitest.json");
  try {
    return produceTiming(args, rawReport);
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
}

function produceTiming(args, rawReport) {
  const result = spawnSync(
    process.execPath,
    [VITEST_CLI, ...vitestArgs(rawReport)],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Keep fixture placement identical to ordinary `pnpm test`: moving the
      // OS temp directory into the checkout leaks ancestor AGENTS.md context
      // and exposes copied test repositories to concurrent Vitest discovery.
    }
  );
  let vitestJson;
  try {
    vitestJson = JSON.parse(readFileSync(rawReport, "utf8"));
  } catch (error) {
    console.error(
      `test:timing error: cannot parse the Vitest JSON report at ${rawReport}: ${error.message}`
    );
    return 1;
  }
  const report = normalizeTiming(vitestJson);
  if (report.entries.length === 0) {
    console.error(
      "test:timing error: the Vitest report produced zero entries; refusing to write an empty artifact"
    );
    return 1;
  }
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `test:timing: ${report.entries.length} test durations -> ${args.out}`
  );
  if (result.status !== 0) {
    const failed = normalizeTiming(
      vitestJson,
      Number.POSITIVE_INFINITY
    ).entries.filter((entry) => entry.status === "failed");
    // Emit bounded identifiers only, never captured output or assertion
    // payloads (which may contain credentials). JSON escapes control chars.
    console.error(
      `test:timing failures: ${JSON.stringify({
        total: failed.length,
        tests: failed.slice(0, 10).map(({ file, name }) => ({
          file: file.slice(0, 200),
          name: name.slice(0, 200),
        })),
      })}`
    );
    console.error(
      "test:timing: the Vitest run failed; the artifact was written for triage"
    );
    return result.status ?? 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
