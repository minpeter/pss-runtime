#!/usr/bin/env node
// check:bundle-size — bundle budget gate for the published dist/ artifacts
// (VAL-SEC-015..019; same wrapper pattern as
// scripts/check-workspace-version-drift.mjs). Baseline semantics live in
// scripts/bundle-size.mjs: explicit per-artifact byte ceilings recorded from
// a reviewed reference build, plus a documented tolerance (5% by default).
//
// Modes:
//   (no args) / --help  print usage and exit 0 (root script supplies --check)
//   --check             GATE: exit non-zero when a measured artifact exceeds
//                       its baseline by more than the tolerance, or when any
//                       declared artifact is missing (dist not built)
//   --report            REPORT: write a bounded JSON report and exit 0
//   --write-baseline    rewrite the baseline from the current build; run only
//                       after pnpm build and review the diff before committing
//
// Missing artifacts fail every mode with the expected path named — a
// missing dist/ never reports zero bytes and passes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BUNDLE_BASELINE_PATH,
  baselineProblems,
  evaluateBudget,
  measureArtifacts,
  overLine,
} from "./bundle-size.mjs";
import { reportTool } from "./report-paths.mjs";

const BUNDLE_REPORT = reportTool("bundle-budget");

const USAGE = `Usage: node scripts/check-bundle-size.mjs <mode> [options]

Modes:
  (no args)            print this usage and exit 0
  --help               print this usage and exit 0
  --check              GATE: fail when an artifact exceeds baseline + tolerance
                       or when a declared artifact is missing (run pnpm build)
  --report             REPORT: write a bounded report and exit 0
  --write-baseline     rewrite the baseline from the current build (reviewed)

Options:
  --root <dir>         workspace root (default: ".")
  --baseline <path>    baseline file (default: ${BUNDLE_BASELINE_PATH})
  --out <path>         report output (default: ${BUNDLE_REPORT.path})

Baselines are explicit numeric byte ceilings per artifact path (no wildcards).
Trailing-slash paths aggregate every file under a published dist tree.
A measured size fails only when it exceeds
ceil(baseline * (1 + tolerancePercent / 100)); the tolerance is documented in
scripts/bundle-size.mjs. Refresh baselines from a reviewed reference build.`;

function parseArgs(argv) {
  const args = {
    help: false,
    mode: null,
    root: ".",
    baseline: BUNDLE_BASELINE_PATH,
    out: BUNDLE_REPORT.path,
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

function loadBaseline(path) {
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const problems = baselineProblems(config);
    return problems.length > 0
      ? { error: `baseline ${path}: ${problems.join("; ")}` }
      : { config };
  } catch (error) {
    return { error: `cannot read baseline ${path}: ${error.message}` };
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function reportMissing(missing) {
  for (const path of missing) {
    console.error(
      `MISSING ${path} — expected built artifact not found at ${path}; run pnpm build first`
    );
  }
  console.error(
    `check:bundle-size GATE failed: ${missing.length} declared artifact(s) missing; a missing dist/ never reports zero and passes`
  );
}

function writeReport(args, rows) {
  const capped = rows.slice(0, BUNDLE_REPORT.cap);
  const truncated = rows.length > BUNDLE_REPORT.cap;
  writeJson(args.out, {
    tool: "bundle-budget",
    baseline: args.baseline,
    totalArtifacts: rows.length,
    over: rows.filter((row) => !row.ok),
    artifacts: capped,
    truncated,
    ...(truncated && {
      note: `report capped at ${BUNDLE_REPORT.cap} entries (reportTool("bundle-budget").cap in scripts/report-paths.mjs)`,
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
  const { config, error } = loadBaseline(args.baseline);
  if (error) {
    console.error(`check:bundle-size error: ${error}`);
    return 1;
  }
  const paths = Object.keys(config.artifacts);
  const { measured, missing } = measureArtifacts(args.root, paths);
  if (missing.length > 0) {
    reportMissing(missing);
    return 1;
  }
  const rows = evaluateBudget(config, measured);
  if (args.mode === "write-baseline") {
    const artifacts = Object.fromEntries(
      paths.map((path) => [path, measured.get(path)])
    );
    writeJson(args.baseline, {
      version: 1,
      tolerancePercent: config.tolerancePercent,
      artifacts,
    });
    console.log(
      `check:bundle-size baseline updated: ${paths.length} artifacts -> ${args.baseline} (review the diff before committing)`
    );
    return 0;
  }
  if (args.mode === "report") {
    writeReport(args, rows);
    console.log(
      `check:bundle-size report: ${rows.length} artifacts (${rows.filter((r) => !r.ok).length} over budget) -> ${args.out}`
    );
    return 0;
  }
  const over = rows.filter((row) => !row.ok);
  if (over.length === 0) {
    console.log(
      `check:bundle-size OK: ${rows.length} artifacts within budget (tolerance ${config.tolerancePercent}%)`
    );
    return 0;
  }
  for (const row of over) {
    console.error(overLine(row));
  }
  console.error(
    `check:bundle-size GATE failed: ${over.length} artifact(s) over budget; shrink the bundle or update ${args.baseline} from a reviewed reference build (--write-baseline)`
  );
  return 1;
}

process.exit(main());
