#!/usr/bin/env node
// check:workspace-drift — shared-dependency version drift gate
// (VAL-SEC-010..014; same wrapper pattern as scripts/check-unused.mjs). The
// compared set, scan, and baseline semantics live in
// scripts/workspace-version-drift.mjs.
//
// Modes:
//   (no args) / --help  print usage and exit 0 — the root
//                       check:workspace-drift script is the usage surface
//   --check             GATE: exit non-zero on an un-baselined divergence or
//                       a stale baseline entry; baselined divergences exit 0
//   --report            REPORT: write a bounded JSON report and exit 0
//   --write-baseline    rewrite the baseline from the current divergences;
//                       the result is a reviewed signature diff

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { reportTool } from "./report-paths.mjs";
import {
  baselineProblems,
  DRIFT_BASELINE_PATH,
  diffDrift,
  findDivergences,
  mismatchLine,
} from "./workspace-version-drift.mjs";

const DRIFT_REPORT = reportTool("drift");

const USAGE = `Usage: node scripts/check-workspace-version-drift.mjs <mode> [options]

Modes:
  (no args)            print this usage and exit 0
  --help               print this usage and exit 0
  --check              GATE: fail on un-baselined drift or stale baseline entries
  --report             REPORT: write a bounded report and exit 0
  --write-baseline     rewrite the baseline from the current divergences

Options:
  --root <dir>         workspace root (default: ".")
  --baseline <path>    baseline file (default: ${DRIFT_BASELINE_PATH})
  --out <path>         report output (default: ${DRIFT_REPORT.path})

Only the declared shared-dependency set is compared. A baseline signature is
"<dependency>: <version> <version>" with the diverging versions sorted.`;

function parseArgs(argv) {
  const args = {
    help: false,
    mode: null,
    root: ".",
    baseline: DRIFT_BASELINE_PATH,
    out: DRIFT_REPORT.path,
  };
  if (argv.length === 0) {
    args.help = true;
    return args;
  }
  const modes = new Set(["--check", "--report", "--write-baseline"]);
  const takesValue = new Set(["--root", "--baseline", "--out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (modes.has(token)) {
      args.mode = token.slice(2);
    } else if (takesValue.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: `option ${token} requires a value` };
      }
      args[token.slice(2)] = value;
      index += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  if (!(args.help || args.mode)) {
    return { error: "a mode is required: --check, --report, --write-baseline" };
  }
  return args;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadBaseline(path) {
  try {
    const baseline = JSON.parse(readFileSync(path, "utf8"));
    const problems = baselineProblems(baseline);
    return problems.length > 0 ? { error: problems.join("; ") } : { baseline };
  } catch (error) {
    return { error: `cannot read baseline ${path}: ${error.message}` };
  }
}

function writeReport(args, divergences, diff) {
  const capped = divergences.slice(0, DRIFT_REPORT.cap);
  const truncated = divergences.length > DRIFT_REPORT.cap;
  writeJson(args.out, {
    tool: "workspace-version-drift",
    baseline: args.baseline,
    totalDivergences: divergences.length,
    unbaselined: diff.unbaselined.map((d) => d.signature),
    stale: diff.stale,
    divergences: capped,
    truncated,
    ...(truncated && {
      note: `report capped at ${DRIFT_REPORT.cap} entries (reportTool("drift").cap in scripts/report-paths.mjs)`,
    }),
  });
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
  let divergences;
  try {
    divergences = findDivergences(args.root);
  } catch (error) {
    console.error(`check:workspace-drift error: ${error.message}`);
    return 1;
  }
  if (args.mode === "write-baseline") {
    const signatures = divergences.map((d) => d.signature).sort();
    writeJson(args.baseline, { version: 1, signatures });
    console.log(
      `check:workspace-drift baseline updated: ${signatures.length} signatures -> ${args.baseline} (review the diff before committing)`
    );
    return 0;
  }
  const { baseline, error } = loadBaseline(args.baseline);
  if (error) {
    console.error(`check:workspace-drift error: ${error}`);
    return 1;
  }
  const diff = diffDrift(divergences, baseline.signatures);
  if (args.mode === "report") {
    writeReport(args, divergences, diff);
    console.log(
      `check:workspace-drift report: ${divergences.length} divergences (${diff.unbaselined.length} un-baselined, ${diff.stale.length} stale) -> ${args.out}`
    );
    return 0;
  }
  if (diff.unbaselined.length === 0 && diff.stale.length === 0) {
    console.log(
      `check:workspace-drift OK: ${divergences.length} divergence(s), all covered by ${baseline.signatures.length} baseline signature(s)`
    );
    return 0;
  }
  for (const divergence of diff.unbaselined) {
    console.error(mismatchLine(divergence));
  }
  for (const signature of diff.stale) {
    console.error(`STALE ${signature}`);
  }
  console.error(
    `check:workspace-drift GATE failed: ${diff.unbaselined.length} un-baselined, ${diff.stale.length} stale signature(s); align the versions or update ${args.baseline} via a reviewed diff (--write-baseline)`
  );
  return 1;
}

process.exit(main());
