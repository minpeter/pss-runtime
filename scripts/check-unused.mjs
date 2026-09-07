#!/usr/bin/env node
// check:unused — Knip wrapper with a signature-based baseline (VAL-SEC-001..004).
//
// Modes:
//   (default)   GATE: exit non-zero iff a finding signature is absent from the
//               committed baseline (new finding) or a baseline signature no
//               longer occurs (stale entry). Findings alone never fail.
//   --report    REPORT: write a bounded JSON report to a gitignored path and
//               exit 0, even when new or stale signatures exist.
//
// Options:
//   --help            print usage and exit 0
//   --report          REPORT mode (root script: check:unused:report)
//   --input <path>    read a knip JSON report instead of running knip (tests)
//   --baseline <path> baseline file (default: scripts/knip-baseline.json)
//   --out <path>      report output (default: report/knip-unused.json)
//   --bin <path>      knip binary (default: node_modules/.bin/knip)
//   --write-baseline  rewrite the baseline from current findings; the result
//                     is a reviewed signature diff, never a numeric count
//
// Tool unavailable (binary missing, fails to execute, or emits no parseable
// report): prints an explicit SKIP message and exits 0 — a documented skip,
// never a silent pass and never a workflow failure (VAL-SEC-004).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  baselineProblems,
  diffSignatures,
  KNIP_BASELINE_PATH,
  KNIP_REPORT_PATH,
  REPORT_ENTRY_CAP,
  signaturesFromReport,
} from "./knip-unused.mjs";

const DEFAULT_BIN = "node_modules/.bin/knip";
const MAX_REPORT_BUFFER = 64 * 1024 * 1024;

const USAGE = `Usage: node scripts/check-unused.mjs [--report] [options]

Modes:
  (default)        GATE: fail only on new or stale finding signatures
  --report         REPORT: write a bounded report and exit 0

Options:
  --help                 print this usage and exit 0
  --input <path>         read a knip JSON report instead of running knip
  --baseline <path>      baseline file (default: scripts/knip-baseline.json)
  --out <path>           report output (default: report/knip-unused.json)
  --bin <path>           knip binary (default: node_modules/.bin/knip)
  --write-baseline       rewrite the baseline from current findings

Reports land on gitignored paths (report/); the baseline is a reviewed
signature list (file + symbol), never a numeric count.`;

function parseArgs(argv) {
  const args = {
    help: false,
    report: false,
    writeBaseline: false,
    input: null,
    baseline: KNIP_BASELINE_PATH,
    out: KNIP_REPORT_PATH,
    bin: DEFAULT_BIN,
  };
  const takesValue = new Set(["--input", "--baseline", "--out", "--bin"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--report") {
      args.report = true;
    } else if (token === "--write-baseline") {
      args.writeBaseline = true;
    } else if (takesValue.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: `option ${token} requires a value` };
      }
      args[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
        value;
      index += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return args;
}

function loadReport(args) {
  if (args.input) {
    try {
      return { report: JSON.parse(readFileSync(args.input, "utf8")) };
    } catch (error) {
      return { error: `cannot read --input report: ${error.message}` };
    }
  }
  if (!existsSync(args.bin)) {
    return {
      skip: `knip binary not found at ${args.bin} — run pnpm install to enable this gate`,
    };
  }
  const result = spawnSync(
    args.bin,
    ["--reporter", "json", "--no-exit-code", "--no-progress"],
    { encoding: "utf8", maxBuffer: MAX_REPORT_BUFFER }
  );
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit ${result.status}`;
    return { skip: `knip failed to execute on this toolchain (${reason})` };
  }
  try {
    return { report: JSON.parse(result.stdout) };
  } catch {
    return { skip: "knip produced no parseable JSON report" };
  }
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeReport(args, signatures, diff, baselineCount) {
  const capped = signatures.slice(0, REPORT_ENTRY_CAP);
  const truncated = signatures.length > REPORT_ENTRY_CAP;
  writeJson(args.out, {
    tool: "knip",
    baseline: args.baseline,
    totalSignatures: signatures.length,
    baselineSignatures: baselineCount,
    newSignatures: diff.newSignatures,
    staleSignatures: diff.staleSignatures,
    signatures: capped,
    truncated,
    ...(truncated && {
      note: `report capped at ${REPORT_ENTRY_CAP} entries (REPORT_ENTRY_CAP in scripts/knip-unused.mjs)`,
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
  const loaded = loadReport(args);
  if (loaded.skip) {
    console.log(
      `SKIP check:unused: ${loaded.skip}; the gate was not evaluated (documented skip, not a pass).`
    );
    return 0;
  }
  if (loaded.error) {
    console.error(`check:unused error: ${loaded.error}`);
    return 1;
  }
  const signatures = signaturesFromReport(loaded.report);
  if (args.writeBaseline) {
    writeJson(args.baseline, { version: 1, signatures });
    console.log(
      `check:unused baseline updated: ${signatures.length} signatures -> ${args.baseline} (review the diff before committing)`
    );
    return 0;
  }
  const { baseline, error } = loadBaseline(args.baseline);
  if (error) {
    console.error(`check:unused error: ${error}`);
    return 1;
  }
  const diff = diffSignatures(signatures, baseline.signatures);
  if (args.report) {
    writeReport(args, signatures, diff, baseline.signatures.length);
    console.log(
      `check:unused report: ${signatures.length} findings (${diff.newSignatures.length} new, ${diff.staleSignatures.length} stale) -> ${args.out}`
    );
    return 0;
  }
  if (diff.newSignatures.length === 0 && diff.staleSignatures.length === 0) {
    console.log(
      `check:unused OK: ${signatures.length} findings, all covered by ${baseline.signatures.length} baseline signatures`
    );
    return 0;
  }
  for (const signature of diff.newSignatures) {
    console.error(`NEW ${signature}`);
  }
  for (const signature of diff.staleSignatures) {
    console.error(`STALE ${signature}`);
  }
  console.error(
    `check:unused GATE failed: ${diff.newSignatures.length} new, ${diff.staleSignatures.length} stale signature(s); update ${args.baseline} via a reviewed diff (--write-baseline)`
  );
  return 1;
}

process.exit(main());
